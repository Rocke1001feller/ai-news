/**
 * Article snapshot + summary builder (P3 pipeline step).
 *
 * Reads data/latest-24h.json, fetches each article URL, extracts the main
 * text with Readability, derives a short summary (meta description preferred,
 * otherwise the first ~220 chars of the extracted text), then:
 *   - writes full snapshots to data/articles/<id>.json
 *   - patches items in latest-24h.json with `summary` + `has_snapshot`
 *
 * Usage: tsx src/snapshot.ts [--limit N] [--input path] [--outdir path]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { isMostlyEnglish } from './utils/text.js';
import {
  translateBlocksToPairs,
  translateSummary,
  type BlockPairs,
  type ZhCache,
} from './translate/fulltext.js';

interface NewsItem {
  id: string;
  site_id: string;
  site_name: string;
  source: string;
  title: string;
  url: string;
  summary?: string;
  summary_zh?: string;
  has_snapshot?: boolean;
  [key: string]: unknown;
}

interface LatestFeed {
  items: NewsItem[];
  [key: string]: unknown;
}

interface ArticleSnapshot {
  id: string;
  url: string;
  title: string;
  site_name: string;
  source: string;
  byline: string | null;
  excerpt: string | null;
  content_html: string;
  /** Sentence-level bilingual pairs per block (contract v2). */
  blocks?: BlockPairs[];
  content_html_zh?: string;
  translated?: boolean;
  content_text: string;
  fetched_at: string;
  ok: boolean;
  error?: string;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 (compatible; AINewsBot/1.0)';
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const SUMMARY_LIMIT = 220;
const CONCURRENCY = 15;
const TRANSLATE_CONCURRENCY = 2;
const ZH_CACHE_FILE = 'data/paragraph-zh-cache.json';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    limit: get('limit') ? parseInt(get('limit')!, 10) : Infinity,
    input: get('input') ?? 'data/latest-24h.json',
    outdir: get('outdir') ?? 'data/articles',
    maxTranslations: get('max-translations') ? parseInt(get('max-translations')!, 10) : 6000,
  };
}

function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Cut at the last sentence boundary before limit; hard-cut as fallback. */
function truncateSentence(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const m = head.match(/^(.*[。！？!?\.…])\s*[^。！？!?\.…]*$/u);
  if (m && m[1].length >= limit * 0.5) return m[1];
  return head.trimEnd() + '…';
}

function buildSummary(metaDesc: string | null, textContent: string | null): string | null {
  const meta = cleanText(metaDesc);
  if (meta.length >= 40) return truncateSentence(meta, SUMMARY_LIMIT);
  const text = cleanText(textContent);
  if (text.length < 40) return null;
  return truncateSentence(text, SUMMARY_LIMIT);
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) throw new Error('page too large');
    return new TextDecoder('utf-8').decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

function extract(html: string, url: string) {
  // linkedom's parseHTML return type doesn't expose `document`; the project
  // tsconfig has no DOM lib, so type it structurally and keep it local.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { document } = parseHTML(html) as unknown as { document: any };
  const metaDesc =
    document.querySelector('meta[name="description"]')?.getAttribute('content') ??
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    null;
  const reader = new Readability(document, { charThreshold: 200 });
  const article = reader.parse();
  return { metaDesc, article, url };
}

async function snapshotItem(item: NewsItem, outdir: string): Promise<ArticleSnapshot> {
  const base: ArticleSnapshot = {
    id: item.id,
    url: item.url,
    title: item.title,
    site_name: item.site_name,
    source: item.source,
    byline: null,
    excerpt: null,
    content_html: '',
    content_text: '',
    fetched_at: new Date().toISOString(),
    ok: false,
  };
  try {
    const html = await fetchHtml(item.url);
    const { metaDesc, article } = extract(html, item.url);
    if (!article || !article.textContent || article.textContent.length < 200) {
      throw new Error('extraction failed or content too short');
    }
    base.ok = true;
    base.title = article.title || item.title;
    base.byline = article.byline ?? null;
    base.excerpt = cleanText(article.excerpt) || null;
    base.content_html = article.content ?? '';
    base.content_text = cleanText(article.textContent);
    base.excerpt = base.excerpt ?? buildSummary(metaDesc, article.textContent);
    item.summary = buildSummary(metaDesc, article.textContent) ?? undefined;
    item.has_snapshot = true;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    item.has_snapshot = false;
  }
  await writeFile(join(outdir, `${item.id}.json`), JSON.stringify(base));
  return base;
}

async function main() {
  const { limit, input, outdir, maxTranslations } = parseArgs();
  if (!existsSync(input)) {
    console.error(`input not found: ${input}`);
    process.exit(1);
  }
  await mkdir(outdir, { recursive: true });

  const feed: LatestFeed = JSON.parse(await readFile(input, 'utf-8'));
  const items = feed.items.slice(0, limit === Infinity ? feed.items.length : limit);
  console.log(`[snapshot] ${items.length} items (limit=${limit === Infinity ? 'none' : limit})`);

  const limiter = pLimit(CONCURRENCY);
  let done = 0;
  const failures = new Map<string, number>();
  const results = await Promise.all(
    items.map((item) =>
      limiter(async () => {
        const snap = await snapshotItem(item, outdir);
        done += 1;
        if (done % 50 === 0) console.log(`[snapshot] progress ${done}/${items.length}`);
        if (!snap.ok) {
          const host = new URL(item.url).hostname;
          failures.set(host, (failures.get(host) ?? 0) + 1);
        }
        return snap;
      }),
    ),
  );

  await writeFile(input, JSON.stringify(feed));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`[snapshot] ok=${okCount} fail=${results.length - okCount} of ${results.length}`);
  if (failures.size > 0) {
    const top = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('[snapshot] top failing hosts:', top.map(([h, n]) => `${h}(${n})`).join(', '));
  }

  // ── Translation pass (build-time bilingual layer) ─────────────────────
  const zhCache: ZhCache = new Map();
  if (existsSync(ZH_CACHE_FILE)) {
    try {
      const data = JSON.parse(await readFile(ZH_CACHE_FILE, 'utf-8'));
      for (const [k, v] of Object.entries<string>(data)) zhCache.set(k, v);
    } catch {
      console.warn('[translate] cache file unreadable, starting fresh');
    }
  }
  console.log(`[translate] cache size=${zhCache.size}, request budget=${maxTranslations}`);

  const budget = { remaining: maxTranslations };
  const itemById = new Map(items.map((it) => [it.id, it]));
  const toTranslate = results.filter(
    (r) => r.ok && isMostlyEnglish(r.content_text),
  );
  console.log(`[translate] ${toTranslate.length} english snapshots to translate`);

  const tLimiter = pLimit(TRANSLATE_CONCURRENCY);
  let articlesTranslated = 0;
  let sentencesTranslated = 0;
  let requestsUsed = 0;
  let cacheHits = 0;
  await Promise.all(
    toTranslate.map((snap) =>
      tLimiter(async () => {
        const r = await translateBlocksToPairs(snap.content_html, zhCache, budget, TRANSLATE_CONCURRENCY);
        sentencesTranslated += r.translatedSentences;
        requestsUsed += r.requests;
        cacheHits += r.fromCache;
        snap.blocks = r.blocks;
        snap.translated = r.translatedSentences > 0;
        if (r.zhHtml) {
          snap.content_html_zh = r.zhHtml;
        }
        if (snap.translated) {
          articlesTranslated += 1;
        }
        await writeFile(join(outdir, `${snap.id}.json`), JSON.stringify(snap));

        const item = itemById.get(snap.id);
        if (item?.summary && isMostlyEnglish(item.summary) && !item.summary_zh) {
          const zhSummary = await translateSummary(item.summary, zhCache, budget);
          if (zhSummary) item.summary_zh = zhSummary;
        }
      }),
    ),
  );

  await writeFile(ZH_CACHE_FILE, JSON.stringify(Object.fromEntries(zhCache)));
  await writeFile(input, JSON.stringify(feed));
  console.log(
    `[translate] articles=${articlesTranslated}/${toTranslate.length} sentences=${sentencesTranslated} requests=${requestsUsed} cacheHits=${cacheHits} budgetLeft=${budget.remaining}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
