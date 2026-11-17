import { addLocalDays, localDate, startOfLocalDay, type LocalDate } from '../src/time/tz.js';

/**
 * Backdated conversations used by both `npm run seed` and `npm run eval`.
 * Dates are computed relative to today, so the challenge's example questions
 * ("on Monday", "last Tuesday", "on 3 November") always have something to recall.
 */
export interface SeedTurn {
  at: Date;
  message: string;
  /** Turns with the same thread id share a conversation. */
  thread: string;
}

function mostRecent(today: LocalDate, weekday: number, minDaysBack: number): LocalDate {
  let back = (today.weekday - weekday + 7) % 7;
  if (back < minDaysBack) back += 7;
  return addLocalDays(today, -back);
}

function at(d: LocalDate, hour: number, minute: number, tz: string): Date {
  return new Date(startOfLocalDay(d.year, d.month, d.day, tz).getTime() + (hour * 60 + minute) * 60_000);
}

export function seedHistory(now: Date, tz: string): SeedTurn[] {
  const today = localDate(now, tz);
  const monday = mostRecent(today, 1, 1);
  const tuesday = mostRecent(today, 2, 1);
  // "3 November" of this year if it's at least a day ago, otherwise 9 days ago.
  const nov3: LocalDate = today.month > 11 || (today.month === 11 && today.day > 3)
    ? { year: today.year, month: 11, day: 3, weekday: 0 }
    : addLocalDays(today, -9);

  const turns: SeedTurn[] = [
    { at: at(nov3, 11, 5, tz), thread: 'node', message: 'What is the latest LTS version of Node.js, and until when is it supported?' },
    { at: at(nov3, 11, 9, tz), thread: 'node', message: 'Is it safe to upgrade a production Express app to it now?' },
    { at: at(nov3, 18, 40, tz), thread: 'budget', message: 'For context: our CRM budget is about $30 per seat per month, and we are a 20-person sales team.' },
    { at: at(monday, 10, 30, tz), thread: 'crm', message: 'We are a 20-person sales team. Shortlist 5 CRM tools for us with their current per-seat pricing for the plan we would need.' },
    { at: at(tuesday, 16, 0, tz), thread: 'pg', message: 'Compare managed Postgres hosting for a small production app: Neon, Supabase, AWS RDS and Render. What does the cheapest production-ready plan cost on each?' },
  ];
  // Knowledge update: only if there's a day between Tuesday and today.
  const yesterday = addLocalDays(today, -1);
  if (startOfLocalDay(yesterday.year, yesterday.month, yesterday.day, tz) > startOfLocalDay(tuesday.year, tuesday.month, tuesday.day, tz)) {
    turns.push({ at: at(yesterday, 9, 15, tz), thread: 'update', message: 'Quick update: our sales team is growing to 35 people next quarter.' });
  }
  return turns.sort((a, b) => a.at.getTime() - b.at.getTime());
}
