/**
 * South African public holidays (Public Holidays Act 36 of 1994, Schedule): 1 Jan, 21 Mar, Good Friday, Family
 * Day (Easter Monday), 27 Apr, 1 May, 16 Jun, 9 Aug, 24 Sep, 16 Dec, 25 Dec, 26 Dec. Section 2(1): a holiday that
 * falls on a Sunday makes the following Monday a holiday too (a Monday that already is one adds nothing).
 *
 * KNOWN LIMIT: days the President proclaims ad hoc under s2(2) (election days, a one-off bridge day such as
 * 27 Dec 2022) cannot be known in advance and are NOT in this calendar. A date on one is treated as a business day.
 *
 * Pure: ISO dates ('YYYY-MM-DD') in, ISO dates out.
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Easter Sunday of `year` (Gregorian; the anonymous / Meeus-Jones-Butcher computus), as an ISO date. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The ISO date `days` after (or before, negative) the ISO date `date`. */
export function addDaysIso(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const dayOfWeek = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

const cache = new Map<number, readonly string[]>();

/** The public holidays of `year`, sorted, including the Mondays the Sunday rule adds. */
export function saPublicHolidays(year: number): readonly string[] {
  const hit = cache.get(year);
  if (hit) return hit;
  const easter = easterSunday(year);
  const statutory = [
    iso(year, 1, 1), iso(year, 3, 21), addDaysIso(easter, -2), addDaysIso(easter, 1), iso(year, 4, 27), iso(year, 5, 1),
    iso(year, 6, 16), iso(year, 8, 9), iso(year, 9, 24), iso(year, 12, 16), iso(year, 12, 25), iso(year, 12, 26),
  ];
  const all = new Set(statutory);
  for (const d of statutory) if (dayOfWeek(d) === 0) all.add(addDaysIso(d, 1));
  const sorted = [...all].sort();
  cache.set(year, sorted);
  return sorted;
}

export function isSaPublicHoliday(date: string): boolean {
  return saPublicHolidays(Number(date.slice(0, 4))).includes(date);
}

/** A business day: Monday to Friday and not a public holiday. */
export function isSaBusinessDay(date: string): boolean {
  const dow = dayOfWeek(date);
  return dow !== 0 && dow !== 6 && !isSaPublicHoliday(date);
}
