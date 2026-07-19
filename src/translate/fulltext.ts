/**
 * Full-text translation for article snapshots (build-time, Google gtx endpoint).
 *
 * Sentence-level contract: each block-level element is split into sentences,
 * every sentence is translated independently (sha1-cached), and the snapshot
 * stores per-block sentence pairs — alignment is guaranteed at the source,
 * the reader never has to guess which zh sentence belongs to which en sentence.
 *
 * zhHtml (paragraph mirror) is still emitted by joining sentence translations,
 * so legacy consumers keep working during the transition.
 *
 * Cache: sha1(sentence) persisted to data/paragraph-zh-cache.json via the
 * data branch, so unchanged sentences are never re-translated.
 */

import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { translateToZhCN } from './google.js';
import { isMostlyEnglish } from '../utils/text.js';
import { splitSentences } from './sentences.js';

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, dd, dt';
const SKIP_ANCESTOR = 'pre, code, script, style';
const MIN_BLOCK_CHARS = 2;

export type ZhCache = Map<string, string>;

export interface SentencePair {
  en: string;
  zh: string | null;
}

export interface BlockPairs {
  /** The block's original HTML (markup preserved). */
  html_en: string;
  /** Empty for non-English blocks (rendered as-is). */
  sentences: SentencePair[];
}

export interface TranslateBlocksResult {
  blocks: BlockPairs[];
  zhHtml: string | null;
  totalSentences: number;
  translatedSentences: number;
  fromCache: number;
  requests: number;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function key(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export async function translateBlocksToPairs(
  html: string,
  cache: ZhCache,
  budget: { remaining: number },
  concurrency = 3,
): Promise<TranslateBlocksResult> {
  // linkedom treats the first tag of a fragment as the document element
  // (leaving body empty) — wrap fragments so body contains the content.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { document } = parseHTML(`<html><body>${html}</body></html>`) as unknown as {
    document: any;
  };

  const blocks: BlockPairs[] = [];
  interface Work {
    block: BlockPairs;
    sentIdx: number;
    text: string;
  }
  const work: Work[] = [];
  const englishEls: Array<{ el: any; block: BlockPairs }> = [];

  for (const el of document.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.closest(SKIP_ANCESTOR)) continue;
    const text = clean(el.textContent ?? '');
    if (text.length < MIN_BLOCK_CHARS) continue;

    if (!isMostlyEnglish(text)) {
      // Already-zh (or mixed) block: keep original markup, no sentences.
      blocks.push({ html_en: el.outerHTML, sentences: [] });
      continue;
    }

    const sentences = splitSentences(text).map((en) => ({ en, zh: null as string | null }));
    const block: BlockPairs = { html_en: el.outerHTML, sentences };
    blocks.push(block);
    englishEls.push({ el, block });
    sentences.forEach((s, sentIdx) => work.push({ block, sentIdx, text: s.en }));
  }

  let translatedSentences = 0;
  let fromCache = 0;
  let requests = 0;
  const queue = [...work];

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const k = key(item.text);
      let zh = cache.get(k) ?? null;
      if (zh) {
        fromCache += 1;
      } else if (budget.remaining > 0) {
        budget.remaining -= 1;
        requests += 1;
        zh = await translateToZhCN(item.text);
        if (zh) cache.set(k, zh);
      }
      if (zh) {
        translatedSentences += 1;
        item.block.sentences[item.sentIdx].zh = zh;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Build the paragraph-level zh mirror from sentence translations.
  for (const { el, block } of englishEls) {
    el.textContent = block.sentences.map((s) => s.zh ?? s.en).join(' ');
  }
  const zhHtml = translatedSentences > 0 ? document.body.innerHTML : null;

  return {
    blocks,
    zhHtml,
    totalSentences: work.length,
    translatedSentences,
    fromCache,
    requests,
  };
}

export async function translateSummary(
  summary: string,
  cache: ZhCache,
  budget: { remaining: number },
): Promise<string | null> {
  const text = clean(summary);
  if (!text || !isMostlyEnglish(text)) return null;
  const k = key(text);
  const hit = cache.get(k);
  if (hit) return hit;
  if (budget.remaining <= 0) return null;
  budget.remaining -= 1;
  const zh = await translateToZhCN(text);
  if (zh) cache.set(k, zh);
  return zh;
}
