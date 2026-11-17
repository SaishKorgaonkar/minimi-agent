import { getDb } from './index.js';
import { id, json } from '../util.js';

/**
 * The storage interface. Everything above this file talks in domain terms
 * (turns, exchanges, claims); only this file knows it's SQLite.
 */

export interface Turn {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  reply_to: string | null;
  sources: string | null;
  meta: string | null;
  created_at: number;
  tz: string;
}

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedAt?: string | null;
  fetchedAt?: number;
}

/** A user question and the assistant's answer to it. */
export interface Exchange {
  userTurnId: string;
  assistantTurnId: string | null;
  conversationId: string;
  question: string;
  answer: string | null;
  sources: Source[];
  createdAt: number;
  tz: string;
}

export interface Claim {
  id: string;
  turn_id: string;
  entity: string;
  attribute: string;
  value: string;
  source_url: string | null;
  checked_at: number;
  superseded_by: string | null;
}

// ---------- conversations & turns ----------

export function ensureConversation(conversationId: string | undefined, at: number): string {
  const db = getDb();
  if (conversationId && db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
    return conversationId;
  }
  const cid = conversationId && /^[\w-]{4,64}$/.test(conversationId) ? conversationId : id('conv');
  db.prepare('INSERT INTO conversations (id, created_at) VALUES (?, ?)').run(cid, at);
  return cid;
}

export function insertTurn(t: Omit<Turn, 'id'> & { id?: string }): string {
  const tid = t.id ?? id(t.role === 'user' ? 'u' : 'a');
  getDb()
    .prepare(`INSERT INTO turns (id, conversation_id, role, content, reply_to, sources, meta, created_at, tz)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tid, t.conversation_id, t.role, t.content, t.reply_to, t.sources, t.meta, t.created_at, t.tz);
  return tid;
}

export function getTurn(turnId: string): Turn | undefined {
  return getDb().prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Turn | undefined;
}

/** Last `limit` turns of a conversation, oldest first. */
export function recentTurns(conversationId: string, limit: number, before = Number.MAX_SAFE_INTEGER): Turn[] {
  const rows = getDb()
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? AND created_at < ?
              ORDER BY created_at DESC LIMIT ?`)
    .all(conversationId, before, limit) as Turn[];
  return rows.reverse();
}

export function conversationTurns(conversationId: string): Turn[] {
  return getDb()
    .prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as Turn[];
}

export function listConversations(limit = 30) {
  return getDb()
    .prepare(`SELECT c.id, c.created_at,
                (SELECT content FROM turns t WHERE t.conversation_id = c.id AND t.role = 'user'
                 ORDER BY created_at ASC LIMIT 1) AS first_question,
                (SELECT MAX(created_at) FROM turns t WHERE t.conversation_id = c.id) AS last_at
              FROM conversations c ORDER BY last_at DESC LIMIT ?`)
    .all(limit) as { id: string; created_at: number; first_question: string | null; last_at: number | null }[];
}

// ---------- exchanges ----------

const EXCHANGE_SQL = `
  SELECT u.id AS userTurnId, a.id AS assistantTurnId, u.conversation_id AS conversationId,
         u.content AS question, a.content AS answer, a.sources AS sources,
         u.created_at AS createdAt, u.tz AS tz
  FROM turns u
  LEFT JOIN turns a ON a.reply_to = u.id AND a.role = 'assistant'
  WHERE u.role = 'user'`;

type ExchangeRow = Omit<Exchange, 'sources'> & { sources: string | null };
const toExchange = (r: ExchangeRow): Exchange => ({ ...r, sources: json<Source[]>(r.sources, []) });

/** Every exchange whose question was asked within [start, end). */
export function exchangesInRange(start: number, end: number, limit = 50, excludeTurnId?: string): Exchange[] {
  return (getDb()
    .prepare(`${EXCHANGE_SQL} AND u.created_at >= ? AND u.created_at < ? AND u.id != ?
              ORDER BY u.created_at ASC LIMIT ?`)
    .all(start, end, excludeTurnId ?? '', limit) as ExchangeRow[]).map(toExchange);
}

export function exchangesByUserTurnIds(ids: string[]): Exchange[] {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return (getDb()
    .prepare(`${EXCHANGE_SQL} AND u.id IN (${marks}) ORDER BY u.created_at ASC`)
    .all(...ids) as ExchangeRow[]).map(toExchange);
}

/** Closest exchanges before and after an empty range, for "nothing on that day; nearest is …". */
export function nearestExchanges(start: number, end: number): { before?: Exchange; after?: Exchange } {
  const db = getDb();
  const before = db.prepare(`${EXCHANGE_SQL} AND u.created_at < ? ORDER BY u.created_at DESC LIMIT 1`).get(start) as ExchangeRow | undefined;
  const after = db.prepare(`${EXCHANGE_SQL} AND u.created_at >= ? ORDER BY u.created_at ASC LIMIT 1`).get(end) as ExchangeRow | undefined;
  return { before: before && toExchange(before), after: after && toExchange(after) };
}

export function countTurns(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n;
}

// ---------- memory index ----------

export function insertMemoryItem(item: { kind: 'turn' | 'fact'; turnId: string; text: string; embedding: Buffer | null; createdAt: number }) {
  getDb()
    .prepare('INSERT INTO memory_items (kind, turn_id, text, embedding, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(item.kind, item.turnId, item.text, item.embedding, item.createdAt);
}

export function hasMemoryItems(turnId: string, kind: 'turn' | 'fact'): boolean {
  return !!getDb().prepare('SELECT 1 FROM memory_items WHERE turn_id = ? AND kind = ? LIMIT 1').get(turnId, kind);
}

// ---------- claims ----------

export function insertClaim(c: Omit<Claim, 'id' | 'superseded_by'>): string {
  const cid = id('clm');
  getDb()
    .prepare(`INSERT INTO claims (id, turn_id, entity, attribute, value, source_url, checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(cid, c.turn_id, c.entity, c.attribute, c.value, c.source_url, c.checked_at);
  return cid;
}

export function claimsForTurns(assistantTurnIds: string[]): Claim[] {
  if (!assistantTurnIds.length) return [];
  const marks = assistantTurnIds.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM claims WHERE turn_id IN (${marks}) ORDER BY entity, attribute`)
    .all(...assistantTurnIds) as Claim[];
}

export function getClaim(claimId: string): Claim | undefined {
  return getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId) as Claim | undefined;
}

/** Follow superseded_by to the newest version of a claim. */
export function latestVersion(claim: Claim): Claim {
  let c = claim;
  for (let i = 0; i < 20 && c.superseded_by; i++) {
    const next = getClaim(c.superseded_by);
    if (!next) break;
    c = next;
  }
  return c;
}

export function supersedeClaim(oldId: string, newId: string) {
  getDb().prepare('UPDATE claims SET superseded_by = ? WHERE id = ?').run(newId, oldId);
}

export function insertVerification(v: {
  claimId: string; status: 'changed' | 'unchanged' | 'unverified'; newValue: string | null;
  evidence: { url: string; title: string }[]; note: string | null; checkedAt: number;
}) {
  getDb()
    .prepare(`INSERT INTO verifications (id, claim_id, status, new_value, evidence, note, checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id('ver'), v.claimId, v.status, v.newValue, JSON.stringify(v.evidence), v.note, v.checkedAt);
}

/** Claims due for a proactive re-check: current versions, not checked since `olderThan`. */
export function claimsToRecheck(olderThan: number, limit: number): Claim[] {
  return getDb()
    .prepare(`SELECT c.* FROM claims c
              WHERE c.superseded_by IS NULL AND c.checked_at < ?
                AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.claim_id = c.id AND v.checked_at >= ?)
              ORDER BY c.checked_at ASC LIMIT ?`)
    .all(olderThan, olderThan, limit) as Claim[];
}

// ---------- snapshots ----------

export interface Snapshot { id: string; url: string; fetched_at: number; content_hash: string; title: string | null; text: string }

export function latestSnapshot(url: string, before = Number.MAX_SAFE_INTEGER): Snapshot | undefined {
  return getDb()
    .prepare('SELECT * FROM snapshots WHERE url = ? AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1')
    .get(url, before) as Snapshot | undefined;
}

export function insertSnapshot(s: Omit<Snapshot, 'id'>): string {
  const sid = id('snap');
  getDb()
    .prepare('INSERT INTO snapshots (id, url, fetched_at, content_hash, title, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, s.url, s.fetched_at, s.content_hash, s.title, s.text);
  return sid;
}

// ---------- nudges ----------

export function insertNudge(n: { claimId: string | null; summary: string; sources: { url: string; title: string }[]; at: number }) {
  getDb()
    .prepare('INSERT INTO nudges (id, claim_id, summary, sources, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id('ndg'), n.claimId, n.summary, JSON.stringify(n.sources), n.at);
}

export function unseenNudges() {
  return (getDb().prepare('SELECT * FROM nudges WHERE seen_at IS NULL ORDER BY created_at DESC LIMIT 20').all() as
    { id: string; claim_id: string | null; summary: string; sources: string; created_at: number }[])
    .map((n) => ({ ...n, sources: json<{ url: string; title: string }[]>(n.sources, []) }));
}

export function markNudgeSeen(nudgeId: string, at: number) {
  getDb().prepare('UPDATE nudges SET seen_at = ? WHERE id = ?').run(at, nudgeId);
}

// ---------- traces ----------

export function insertTrace(t: { turnId: string; step: string; startedAt: number; durationMs: number | null; data: unknown }) {
  getDb()
    .prepare('INSERT INTO traces (turn_id, step, started_at, duration_ms, data) VALUES (?, ?, ?, ?, ?)')
    .run(t.turnId, t.step, t.startedAt, t.durationMs, JSON.stringify(t.data ?? null));
}

export function tracesForTurn(turnId: string) {
  return (getDb().prepare('SELECT * FROM traces WHERE turn_id = ? ORDER BY id ASC').all(turnId) as
    { id: number; step: string; started_at: number; duration_ms: number | null; data: string }[])
    .map((t) => ({ ...t, data: json<unknown>(t.data, null) }));
}
