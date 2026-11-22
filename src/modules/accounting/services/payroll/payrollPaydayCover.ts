/**
 * Whether a run was approved over its payday (gate item 1 on 06c106a94d; review M1 of e9f437f366): some interval of its
 * approval_history (migration 925, a tstzmultirange of [approved_at, reopened_at) per approval) OVERLAPS its payday,
 * the SAST day [00:00, next day 00:00) of its pay date. Then its salaries left on payday, even if it has since been
 * reopened: approved on 10 Nov and reopened at 14:00 on a 20 Nov payday was paid; approved 10 Nov and reopened 12 Nov
 * was not. One definition, used by:
 *  - offCyclePayDateRefusal (TS, on the row read): a correction approved after payday is allowed only then;
 *  - the owner cash forecast's "disbursed" (SQL, approvalCoveredPaydaySql).
 * This is not the 999x snapshot trigger's test (an approval at or before the frozen payday end, reopened after it) nor
 * paidCaps' (the frozen payday passed): those decide what the paid amount is, this whether payment happened at all.
 * South Africa keeps no daylight saving: payday runs from 22:00 UTC the day before to 22:00 UTC on the pay date.
 */
const SAST_OFFSET = '+02:00';
const DAY_MS = 86_400_000;

/** Payday's [start, end) as epoch ms, for `payDate` 'YYYY-MM-DD'. */
const payday = (payDate: string): { start: number; end: number } => {
  const start = new Date(`${payDate}T00:00:00${SAST_OFFSET}`).getTime();
  return { start, end: start + DAY_MS };
};

/** A bound of a range's text form: '' unbounded (null), infinity / -infinity as such (review L1), else epoch ms. */
const bound = (text: string): number | null => {
  const t = text.trim().replace(/^"|"$/g, '');
  if (t === '') return null;
  if (t === 'infinity') return Infinity;
  if (t === '-infinity') return -Infinity;
  const ms = new Date(t.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).getTime();
  return Number.isNaN(ms) ? NaN : ms;
};

/** The approval_history (its pg text form, '{["a","b"), ...}') has an interval overlapping `payDate`'s payday. */
export function approvalCoveredPayday(history: unknown, payDate: string | null): boolean {
  if (history == null || payDate == null) return false;
  const { start, end } = payday(payDate);
  for (const m of String(history).matchAll(/([[(])([^,\])]*),([^\])]*)([\])])/g)) {
    // The lower bound's inclusivity cannot change an overlap with a half-open day it starts before (lower < end).
    const [, , lo, hi, close] = m;
    const lower = bound(lo!);
    const upper = bound(hi!);
    if (Number.isNaN(lower) || Number.isNaN(upper)) continue;
    // Overlap with [start, end): the interval begins before payday ends and ends after payday begins.
    const beginsBeforeEnd = lower === null || lower < end;
    const endsAfterStart = upper === null || upper > start || (upper === start && close === ']');
    if (beginsBeforeEnd && endsAfterStart) return true;
  }
  return false;
}

/** The same predicate in SQL, for the header aliased `alias` (its pay date: run_date, else period_end). */
export function approvalCoveredPaydaySql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`approvalCoveredPaydaySql: not an SQL alias: ${alias}`);
  const d = `COALESCE(${alias}.run_date, ${alias}.period_end)`;
  return `COALESCE(${alias}.approval_history && tstzrange((${d})::timestamp AT TIME ZONE 'Africa/Johannesburg', `
    + `(${d} + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg', '[)'), false)`;
}
