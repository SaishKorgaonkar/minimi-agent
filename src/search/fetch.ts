import { config } from '../config.js';
import { sha256 } from '../util.js';

/**
 * Fetch a page and reduce it to readable text. No headless browser: pages that
 * only render with JavaScript come back thin, and callers fall back to the
 * provider's snippet (and say "couldn't verify" when that isn't enough).
 */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  hash: string;
}

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 60_000;

export async function fetchPage(url: string, timeoutMs = config.search.fetchTimeoutMs): Promise<FetchedPage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; chat-agent/0.1)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|xhtml/.test(type)) return null;
    const raw = (await res.text()).slice(0, MAX_BYTES);
    const { title, text } = type.includes('text/plain') ? { title: url, text: raw } : htmlToText(raw);
    const clean = text.slice(0, MAX_TEXT);
    if (clean.length < 200) return null;
    return { url, title: title || url, text: clean, hash: contentHash(clean) };
  } catch {
    return null;
  }
}

/** Hash of the text with digits-in-timestamps and whitespace noise removed. */
export function contentHash(text: string): string {
  const normalised = text
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')   // clock times
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(normalised);
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  body = body
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');
  return { title, text };
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/**
 * Pick the passages of `text` most relevant to `query`: split into ~600-char
 * chunks, score by query-term overlap (prices and numbers count extra), keep the
 * best few in document order.
 */
export function bestPassages(text: string, query: string, max = 3, size = 600): string[] {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9$€£₹.]+/g) ?? [])].filter((t) => t.length > 2 && !STOP.has(t));
  const paras = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n' + p).length > size && cur) { chunks.push(cur); cur = p; } else cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  const scored = chunks.map((c, i) => {
    const lc = c.toLowerCase();
    let score = 0;
    for (const t of terms) if (lc.includes(t)) score += 1;
    if (/[$€£₹]\s?\d|\d+\s?(\/mo|per month|per user|\/user)/i.test(c)) score += 0.5;
    return { c, i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((s) => s.c.slice(0, size + 200));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'has', 'have', 'any', 'since', 'did', 'are', 'was', 'this', 'that', 'from', 'your', 'you', 'its', 'about', 'which', 'when', 'does', 'into']);
