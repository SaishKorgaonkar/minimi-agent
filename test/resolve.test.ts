import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRange } from '../src/time/resolve.js';
import { isoDay } from '../src/time/tz.js';

// Thu 12 Nov 2026, 15:00 IST
const NOW = new Date('2026-11-12T15:00:00+05:30');
const TZ = 'Asia/Kolkata';
const day = (msg: string) => {
  const r = resolveDateRange(msg, NOW, TZ);
  return r && { start: isoDay(r.start, TZ), endExcl: isoDay(r.end, TZ), g: r.granularity, label: r.label };
};

test('weekday = most recent past occurrence', () => {
  assert.equal(day('On Monday we shortlisted 5 CRM tools for a 20-person sales team')?.start, '2026-11-09');
  assert.equal(day('Last Tuesday I asked you about Postgres hosting')?.start, '2026-11-10');
  assert.equal(day('what did we discuss last thursday?')?.start, '2026-11-05'); // today is Thu
  assert.equal(day('what did we discuss on thursday?')?.start, '2026-11-05'); // today's weekday → a week ago
  assert.equal(day('what did we discuss this thursday?')?.start, '2026-11-12');
});

test('absolute dates', () => {
  // The challenge's own example: "3 November" must win over "today".
  assert.equal(day('What did I ask you on 3 November? Is your answer still correct today?')?.start, '2026-11-03');
  assert.equal(day('What did I ask you on 3 November?')?.start, '2026-11-03');
  assert.equal(day('what about Nov 3rd')?.start, '2026-11-03');
  assert.equal(day('what did I ask on 25 December')?.start, '2025-12-25'); // future → last year
  assert.equal(day('anything from October?')?.g, 'month');
});

test('relative words', () => {
  assert.equal(day('what did I ask yesterday')?.start, '2026-11-11');
  assert.equal(day('3 days ago we talked about pricing')?.start, '2026-11-09');
  const lw = day('what did we talk about last week');
  assert.deepEqual([lw?.start, lw?.endExcl], ['2026-11-02', '2026-11-09']);
});

test('today only for our own conversation; "now" is not a date', () => {
  assert.equal(day('what did I ask you this morning?')?.start, '2026-11-12');
  assert.equal(day("what's the weather in Bengaluru today?"), null);
  assert.equal(day('What are the cheapest Postgres hosts right now?'), null);
  assert.equal(day('Is your answer still correct now?'), null);
});

test('no date', () => {
  assert.equal(day('What is the latest Postgres version?'), null);
  assert.equal(day('compare 5 CRM tools for 20 people'), null);
});
