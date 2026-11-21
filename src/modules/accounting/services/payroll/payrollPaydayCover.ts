/**
 * Whether a run was approved THROUGH its payday (gate item 1 on 06c106a94d): some interval of its approval_history
 * (migration 925, a tstzmultirange of [approved_at, reopened_at) per approval) covers the moment payday ends, 00:00 SAST
 * on the day after its pay date, so its salaries left on payday even if it has since been reopened. The END of payday,
 * not its start: a run may be approved on its pay date itself (offCyclePayDateRefusal), and one approved at 10:00 on
 * payday and paid was disbursed; the 999x snapshot trigger and paidCaps read payday's end the same way. One definition,
 * used by:
 *  - offCyclePayDateRefusal (TS, on the row read): a correction approved after payday is allowed only then;
 *  - the owner cash forecast's "disbursed" (SQL, approvalCoveredPaydaySql).
 * South Africa keeps no daylight saving: payday ends at 22:00 UTC on the pay date.
 */
const SAST_OFFSET = '+02:00';

/** The instant payday ends (the next day's 00:00 SAST), for `payDate` 'YYYY-MM-DD'. */
const paydayEnd = (payDate: string): number => new Date(`${payDate}T00:00:00${SAST_OFFSET}`).getTime() + 86_400_000;

/** A bound of a range's text form ('' = unbounded), as an epoch ms. */
const bound = (text: string): number | null => {
  const t = text.trim().replace(/^"|"$/g, '');
  if (t === '') return null;
  const iso = t.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? NaN : ms;
};

/** The approval_history (its pg text form, '{["a","b"), ...}') covers the end of `payDate`'s payday. */
export function approvalCoveredPayday(history: unknown, payDate: string | null): boolean {
  if (history == null || payDate == null) return false;
  const at = paydayEnd(payDate);
  for (const m of String(history).matchAll(/([[(])([^,\])]*),([^\])]*)([\])])/g)) {
    const [, open, lo, hi, close] = m;
    const lower = bound(lo!);
    const upper = bound(hi!);
    if (Number.isNaN(lower) || Number.isNaN(upper)) continue;
    const afterLower = lower === null || lower < at || (lower === at && open === '[');
    const beforeUpper = upper === null || at < upper || (at === upper && close === ']');
    if (afterLower && beforeUpper) return true;
  }
  return false;
}

/** The same predicate in SQL, for the header aliased `alias` (its pay date: run_date, else period_end). */
export function approvalCoveredPaydaySql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`approvalCoveredPaydaySql: not an SQL alias: ${alias}`);
  return `COALESCE(${alias}.approval_history @> ((COALESCE(${alias}.run_date, ${alias}.period_end) + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg'), false)`;
}
