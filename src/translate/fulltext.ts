/**
 * Full-text translation for article snapshots (build-time, Google gtx endpoint).
 *
 * Walks block-level elements of the Readability HTML, translates each block's
 * text as a unit (sentence coherence beats inline markup: block content is
 * replaced with the translated plain text), and returns a structurally
 * identical HTML with zh text where translation succeeded — untranslated
 * blocks keep the original English so partial coverage still renders fine.
 *
 * Cache: paragraph-level sha1 cache persisted to data/paragraph-zh-cache.json
 * via the data branch, so unchanged paragraphs are never re-translated.
 */

import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { translateToZhCN } from './google.js';
import { isMostlyEnglish } from '../utils/text.js';

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, dd, dt';
const SKIP_ANCESTOR = 'pre, code, script, style';
const MIN_BLOCK_CHARS = 2;

export type ZhCache = Map<string, string>;

export interface TranslateResult {
  zhHtml: string | null;
  totalBlocks: number;
  translatedBlocks: number;
  fromCache: number;
  requests: number;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function key(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export async function translateHtmlToZh(
  html: string,
  cache: ZhCache,
  budget: { remaining: number },
  concurrency = 3,
): Promise<TranslateResult> {
  // linkedom treats the first tag of a fragment as the document element
  // (leaving body empty) — wrap fragments so body contains the content.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { document } = parseHTML(`<html><body>${html}</body></html>`) as unknown as {
    document: any;
  };

  const blocks: Array<{ text: string; el: any }> = [];
  for (const el of document.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.closest(SKIP_ANCESTOR)) continue;
    const text = clean(el.textContent ?? '');
    if (text.length < MIN_BLOCK_CHARS || !isMostlyEnglish(text)) continue;
    blocks.push({ text, el });
  }

  if (blocks.length === 0) {
    return { zhHtml: null, totalBlocks: 0, translatedBlocks: 0, fromCache: 0, requests: 0 };
  }

  let translatedBlocks = 0;
  let fromCache = 0;
  let requests = 0;
  const queue = [...blocks];

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
        translatedBlocks += 1;
        item.el.textContent = zh;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const zhHtml = translatedBlocks > 0 ? document.body.innerHTML : null;
  return { zhHtml, totalBlocks: blocks.length, translatedBlocks, fromCache, requests };
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
