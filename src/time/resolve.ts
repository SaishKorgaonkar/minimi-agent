import * as chrono from 'chrono-node';
import {
  addLocalDays, formatDay, localDate, startOfLocalDay, tzOffsetMinutes, type LocalDate,
} from './tz.js';

/**
 * Turns "last Tuesday", "on 3 November", "yesterday", "last week" into an exact
 * [start, end) range in the user's timezone. Deterministic code, not the LLM:
 * calendar maths is where language models are least reliable, and this is the
 * step LongMemEval found matters most for temporal questions.
 */
export interface DateRange {
  start: Date;
  end: Date;           // exclusive
  label: string;       // "Mon 3 Nov", "week of 3 Nov", ...
  granularity: 'day' | 'week' | 'month' | 'span';
  text: string;        // the words that produced it
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = new RegExp(
  // Short forms "sat"/"sun" are left out on purpose: too often ordinary words.
  `\\b(?:(last|this past|past|previous|this|on)\\s+)?(${WEEKDAYS.join('|')}|mon|tue|tues|wed|thu|thur|thurs|fri)\\b`, 'i',
);
const SHORT: Record<string, number> = { mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5 };

function dayRange(d: LocalDate, tz: string, text: string): DateRange {
  const start = startOfLocalDay(d.year, d.month, d.day, tz);
  const next = addLocalDays(d, 1);
  return { start, end: startOfLocalDay(next.year, next.month, next.day, tz), label: formatDay(start, tz), granularity: 'day', text };
}

function spanRange(from: LocalDate, toExclusive: LocalDate, tz: string, text: string, granularity: DateRange['granularity'], label: string): DateRange {
  return {
    start: startOfLocalDay(from.year, from.month, from.day, tz),
    end: startOfLocalDay(toExclusive.year, toExclusive.month, toExclusive.day, tz),
    label, granularity, text,
  };
}

export function resolveDateRange(message: string, now: Date, tz: string): DateRange | null {
  const today = localDate(now, tz);
  const msg = message.toLowerCase();

  // 1. Fixed relative words.
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/\bday before yesterday\b/))) return dayRange(addLocalDays(today, -2), tz, m[0]);
  if ((m = msg.match(/\byesterday\b/))) return dayRange(addLocalDays(today, -1), tz, m[0]);
  if ((m = msg.match(/\b(\d{1,2}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/))) {
    const n = wordNum(m[1]);
    return dayRange(addLocalDays(today, -n), tz, m[0]);
  }
  if ((m = msg.match(/\b(?:in the |over the )?(?:past|last)\s+(\d{1,2}|two|three|four|five|six|seven|ten|fourteen)\s+days\b/))) {
    const n = wordNum(m[1]);
    const from = addLocalDays(today, -n);
    return spanRange(from, addLocalDays(today, 1), tz, m[0], 'span', `last ${n} days`);
  }

  // 2. Weeks and months (Monday-start weeks).
  const mondayThisWeek = addLocalDays(today, -((today.weekday + 6) % 7));
  if ((m = msg.match(/\b(a week ago|one week ago)\b/))) return dayRange(addLocalDays(today, -7), tz, m[0]);
  if ((m = msg.match(/\b(last week|previous week)\b/))) {
    const from = addLocalDays(mondayThisWeek, -7);
    return spanRange(from, mondayThisWeek, tz, m[0], 'week', `week of ${formatDay(startOfLocalDay(from.year, from.month, from.day, tz), tz)}`);
  }
  if ((m = msg.match(/\b(this week|earlier this week)\b/))) {
    return spanRange(mondayThisWeek, addLocalDays(today, 1), tz, m[0], 'week', 'this week');
  }
  if ((m = msg.match(/\b(last month|previous month)\b/))) {
    const from = { year: today.month === 1 ? today.year - 1 : today.year, month: today.month === 1 ? 12 : today.month - 1, day: 1, weekday: 0 };
    const to = { year: today.year, month: today.month, day: 1, weekday: 0 };
    return spanRange(from, to, tz, m[0], 'month', monthLabel(from));
  }
  if ((m = msg.match(/\b(this month|earlier this month)\b/))) {
    const from = { ...today, day: 1 };
    return spanRange(from, addLocalDays(today, 1), tz, m[0], 'month', monthLabel(from));
  }

  // 3. Weekdays: the most recent past occurrence. Naming today's weekday ("on Monday",
  //    said on a Monday) means a week ago: people say "today" for today. "this Monday" = today.
  if ((m = msg.match(WEEKDAY_RE))) {
    const word = m[2].toLowerCase();
    const target = WEEKDAYS.includes(word) ? WEEKDAYS.indexOf(word) : SHORT[word];
    if (target !== undefined) {
      let back = (today.weekday - target + 7) % 7;
      if (back === 0 && !(m[1] && /^this$/i.test(m[1]))) back = 7;
      return dayRange(addLocalDays(today, -back), tz, m[0]);
    }
  }

  // 4. Absolute dates ("3 November", "Nov 3rd", "2026-11-03") via chrono.
  const offset = tzOffsetMinutes(now, tz);
  const results = chrono.parse(message, { instant: now, timezone: offset });
  for (const r of results) {
    const s = r.start;
    if (!s.isCertain('month')) continue; // ignore bare numbers and times
    if (!/\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(r.text)) continue; // "now", "tomorrow"…
    let year = s.get('year')!;
    const month = s.get('month')!;
    if (!s.isCertain('day')) {
      if (!s.isCertain('year') && (year > today.year || (year === today.year && month > today.month))) year -= 1;
      const from = { year, month, day: 1, weekday: 0 };
      const to = { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, day: 1, weekday: 0 };
      return spanRange(from, to, tz, r.text, 'month', monthLabel(from));
    }
    const day = s.get('day')!;
    // A date without a year that would be in the future means last year's.
    if (!s.isCertain('year')) {
      const candidate = startOfLocalDay(year, month, day, tz);
      if (candidate.getTime() > now.getTime()) year -= 1;
    }
    if (r.end && r.end.isCertain('day')) {
      const e = { year: r.end.get('year')!, month: r.end.get('month')!, day: r.end.get('day')!, weekday: 0 };
      const from = { year, month, day, weekday: 0 };
      return spanRange(from, addLocalDays(e, 1), tz, r.text, 'span', r.text);
    }
    return dayRange({ year, month, day, weekday: 0 }, tz, r.text);
  }

  // 5. "Today" last: "on 3 November… is it still correct today?" refers to 3 November.
  //    And only about our own conversation ("what did I ask today"), not "weather today".
  if ((m = msg.match(/\b(today|this morning|this afternoon|this evening|earlier today|tonight)\b/))
      && /\b(ask|asked|discuss|discussed|talk|talked|said|told|tell|chat|mention|mentioned|we|our)\b/.test(msg)) {
    return dayRange(today, tz, m[0]);
  }
  return null;
}

function wordNum(w: string): number {
  const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };
  return words[w] ?? Number(w);
}

function monthLabel(d: { year: number; month: number }): string {
  return new Date(Date.UTC(d.year, d.month - 1, 15)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
