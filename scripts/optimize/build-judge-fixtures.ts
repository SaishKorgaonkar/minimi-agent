/**
 * Builds judge test cases with known answers from real claims and the real
 * page snapshots they came from (data/agent.db and data/eval/agent.db):
 *   unchanged  — the claim as stated, evidence shows the same value
 *   changed    — the claim's number altered; evidence still shows the real one
 *   unverified — the claim's own passages removed from the evidence
 * Run once; the output is committed so optimisation runs are reproducible.
 */
import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { bestPassages } from '../../src/search/fetch.js';
import { groupLabel, vendorKey } from '../../src/claims/verify.js';

type Label = 'unchanged' | 'changed' | 'unverified';
interface Row { entity: string; attribute: string; value: string; source_url: string; checked_at: number; text: string; title: string }

const rows: Row[] = [];
const seen = new Set<string>();
for (const file of ['data/agent.db', 'data/eval/agent.db']) {
  if (!existsSync(file)) continue;
  const db = new Database(file, { readonly: true });
  const found = db.prepare(`
    SELECT c.entity, c.attribute, c.value, c.source_url, c.checked_at, s.text, s.title
    FROM claims c JOIN snapshots s ON s.url = c.source_url
    WHERE c.superseded_by IS NULL
    GROUP BY c.id`).all() as Row[];
  for (const r of found) {
    const key = `${r.entity}|${r.attribute}|${r.value}`.toLowerCase();
    if (seen.has(key)) continue;
    const passages = grounded(r);
    if (!passages.length) continue;
    seen.add(key);
    rows.push(r);
  }
}

/** The numbers in a value ("$6", "0.30", "2027"). Claims without numbers are not used. */
function numbers(value: string): string[] {
  return [...new Set(value.match(/\$?\d+(?:[.,]\d+)*/g) ?? [])];
}

/** A number appears in text as a whole token: "$9" is not found in "$19", "6" not in "256". */
function hasNumber(text: string, n: string): boolean {
  const esc = n.replace(/[$.]/g, (c) => `\\${c}`);
  return new RegExp(`(?<![\\d.,$])${esc}(?![\\d]|[.,]\\d)`).test(text);
}

/** The evidence shows a value when every number in it appears. */
function shows(text: string, value: string): boolean {
  const ns = numbers(value);
  return ns.length > 0 && ns.every((n) => hasNumber(text, n));
}

/** Fixtures are committed: drop contact details that scraped pages carry (press contacts etc.). */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\+\d[\d\s/()-]{7,}\d/g, '[phone]');
}

function grounded(r: Row): string[] {
  if (!numbers(r.value).length) return [];
  const ps = bestPassages(scrub(r.text), `${r.attribute} ${r.value}`, 2, 600);
  return shows(ps.join(' '), r.value) ? ps.filter((p) => numbers(r.value).some((n) => hasNumber(p, n))) : [];
}

function mutate(value: string): string | null {
  const m = value.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  const next = m[0].includes('.')
    ? (n + Math.pow(10, -(m[0].split('.')[1].length)) * 3).toFixed(m[0].split('.')[1].length)
    : String(n + Math.max(1, Math.round(n * 0.2)));
  return value.replace(m[0], next);
}

const groups = new Map<string, Row[]>();
for (const r of rows) groups.set(vendorKey(r.entity), [...(groups.get(vendorKey(r.entity)) ?? []), r]);

const fixtures: unknown[] = [];
const cycle: Label[] = ['unchanged', 'changed', 'unverified'];
for (const [vendor, list] of groups) {
  const claims = list.slice(0, 3);
  for (const offset of [0, 1]) {
    const items: { entity: string; attribute: string; value: string; checked_at: number; source_url: string; truth: Label; trueValue: string }[] = [];
    const passagesByClaim = claims.map(grounded);
    let label = offset;
    claims.forEach((c, i) => {
      let truth = cycle[(label++) % 3];
      let value = c.value;
      if (truth === 'changed') {
        const m = mutate(c.value);
        if (m) value = m; else truth = 'unchanged';
      }
      items.push({ entity: c.entity, attribute: c.attribute, value, checked_at: c.checked_at, source_url: c.source_url, truth, trueValue: c.value });
      void i;
    });
    // Evidence: the claims' passages, minus any passage that shows an
    // "unverified" claim's value. Then every label is recomputed from the
    // final evidence, so truth always matches what the judge can see.
    const hidden = items.filter((it) => it.truth === 'unverified').flatMap((it) => numbers(it.trueValue));
    const byUrl = new Map<string, string[]>();
    items.forEach((it, i) => {
      const keep = passagesByClaim[i].filter((p) => !hidden.some((h) => hasNumber(p, h)));
      if (keep.length) byUrl.set(it.source_url, [...new Set([...(byUrl.get(it.source_url) ?? []), ...keep])]);
    });
    const text = [...byUrl.values()].flat().join(' ');
    if (!text) continue;
    for (const it of items) {
      if (!shows(text, it.trueValue)) it.truth = 'unverified';
      else if (it.truth === 'unverified') it.truth = 'unchanged';
      // A "changed" claim is only changed if its altered value is genuinely absent.
      if (it.truth === 'changed' && shows(text, it.value)) it.truth = 'unchanged';
    }
    const evidence = [...byUrl.entries()].map(([url, ps], k) => ({
      n: k + 1, url, title: list.find((r) => r.source_url === url)?.title ?? url, publishedAt: null,
      fetchedAt: 0, passages: ps.slice(0, 3), foundBy: ['refetch'],
    }));
    fixtures.push({
      id: `${vendor}-${offset}`, vendor,
      entity: groupLabel([...new Set(claims.map((c) => c.entity))]),
      claims: items.map(({ truth, trueValue, ...c }) => c),
      truth: items.map((it) => ({ status: it.truth, value: it.trueValue })),
      evidence,
    });
  }
}

writeFileSync('scripts/optimize/fixtures/judge.json', JSON.stringify(fixtures, null, 1));
const counts: Record<string, number> = {};
for (const f of fixtures as any[]) for (const t of f.truth) counts[t.status] = (counts[t.status] ?? 0) + 1;
console.log(`${fixtures.length} fixtures from ${groups.size} vendors, ${rows.length} grounded claims`, counts);
