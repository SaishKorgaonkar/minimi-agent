/**
 * Small timezone helpers built on Intl, so we don't need a date library.
 * All storage is epoch ms (UTC); these convert to and from a user's local calendar.
 */

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at instant `at`, in minutes (IST → 330). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

export interface LocalDate { year: number; month: number; day: number; weekday: number }

/** Calendar date of instant `at` as seen in `tz`. weekday: 0 = Sunday. */
export function localDate(at: Date, tz: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

/** UTC instant of local midnight at the start of y-m-d in `tz`. */
export function startOfLocalDay(year: number, month: number, day: number, tz: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day));
  // Two passes handle DST transitions correctly.
  let t = guess.getTime() - tzOffsetMinutes(guess, tz) * 60_000;
  t = guess.getTime() - tzOffsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

export function addLocalDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), weekday: t.getUTCDay() };
}

/** "Mon 3 Nov" style label in the user's timezone. */
export function formatDay(at: Date, tz: string, withYear = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  }).format(at);
}

export function formatDateTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

/** YYYY-MM-DD of an instant in `tz`. */
export function isoDay(at: Date, tz: string): string {
  const d = localDate(at, tz);
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
