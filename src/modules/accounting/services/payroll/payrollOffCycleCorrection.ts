/**
 * Correcting an off-cycle run that was approved before (wave 6 OC, review #1620 final breaker M and its delta):
 *
 *  - The month's EMP201 (emp201FiledForMonth): once a finalised or filed EMP201 version, or a legacy submitted or
 *    accepted EMP201, covers the month, the filed declaration stands. An off-cycle run of that month is not reopened
 *    after its pay date (payrollOffCycleGates), and none is calculated or approved again (offCycleFiledMonthRefusal):
 *    a run reopened before the filing would otherwise be approved again outside the filed return (delta M2).
 *  - Raising paid pay (delta M1, review #1679 M): after its pay date a run's pay was paid, so a correction may only
 *    lower it. Each employee's gross as last approved is snapshotted by 999x's payroll_off_cycle_paid_snapshot trigger
 *    when the run leaves 'approved' (payroll_run_headers.off_cycle_paid_gross, which no app_user write can set or move).
 *    Approval refuses any employee's gross above it, bonus or termination run alike (offCycleRaisedAfterPayRefusal);
 *    the bonus amount edit refuses it up front (offCycleRaiseRefusal). The difference is paid by a new off-cycle run.
 * Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate } from '@/utils/dateFormat';
import { formatMoney } from '@/lib/money/formatMoney';

type RunFacts = {
  id?: unknown; run_kind?: unknown; run_date?: unknown; period_year?: unknown; period_month?: unknown; off_cycle_paid_gross?: unknown;
  approval_history?: unknown; off_cycle_payday_at?: unknown;
};

/** A run's approval_history (migration 925, a tstzmultirange): non-empty once it was approved and reopened. */
export function wasApprovedBefore(history: unknown): boolean {
  if (history == null) return false;
  const text = String(history).trim();
  return text !== '' && text !== '{}';
}

/**
 * What covers a month's EMP201 (wave 7 EL, W25): a version that was filed (filed_at set, so a filed version later
 * amended still counts: SARS holds that filing; its PRN), a legacy submitted or accepted submission no version names
 * (its recorded reference, if any; a submission the lifecycle filed is named by its version and judged there), or a
 * finalised version not filed yet (no PRN: its version number). In that order of preference, the latest filed version
 * first, so the refusal names the strongest record. Null when none covers the month. A plain read.
 */
export interface Emp201Filing {
  source: 'filed_version' | 'legacy_submission' | 'finalised_version';
  reference: string | null;
  versionNo: number | null;
}

export async function emp201FilingFor(companyId: string, year: number, month: number, db: TxSql = sql): Promise<Emp201Filing | null> {
  const rows = (await db`
    SELECT x.source, x.reference, x.version_no FROM (
      SELECT CASE WHEN v.filed_at IS NOT NULL THEN 'filed_version' ELSE 'finalised_version' END AS source,
             v.filed_reference AS reference, v.version_no, CASE WHEN v.filed_at IS NOT NULL THEN 0 ELSE 2 END AS rank
        FROM tax_return_versions v
       WHERE v.company_id = ${companyId}::uuid AND v.form_type = 'EMP201'
         AND (v.status IN ('finalised', 'filed') OR v.filed_at IS NOT NULL)
         AND v.period_start <= (make_date(${year}::int, ${month}::int, 1) + INTERVAL '1 month - 1 day')::date
         AND v.period_end >= make_date(${year}::int, ${month}::int, 1)
      UNION ALL
      SELECT 'legacy_submission', s.submission_reference, NULL, 1
        FROM sars_submissions s
       WHERE s.company_id = ${companyId}::uuid AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
         AND s.period_start <= (make_date(${year}::int, ${month}::int, 1) + INTERVAL '1 month - 1 day')::date
         AND s.period_end >= make_date(${year}::int, ${month}::int, 1)
         AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.company_id = s.company_id AND t.sars_submission_id = s.id)
    ) x
    ORDER BY x.rank, x.version_no DESC NULLS LAST
    LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const reference = r.reference == null || String(r.reference).trim() === '' ? null : String(r.reference);
  return { source: r.source as Emp201Filing['source'], reference, versionNo: r.version_no == null ? null : Number(r.version_no) };
}

/** How a refusal names the filing: "filed with reference 7…", "finalised as version 2 (not filed yet)". */
export function emp201FilingText(f: Emp201Filing): string {
  if (f.source === 'finalised_version') return `is finalised as version ${f.versionNo ?? '?'} (not filed yet)`;
  const ref = f.reference === null ? 'no reference recorded' : `reference ${f.reference}`;
  return f.source === 'filed_version' ? `is filed (${ref})` : `was submitted outside the return lifecycle (${ref})`;
}

/** A finalised or filed EMP201 (a version once filed, or a legacy submitted or accepted one) covers the month. */
export async function emp201FiledForMonth(companyId: string, year: number, month: number, db: TxSql = sql): Promise<boolean> {
  return (await emp201FilingFor(companyId, year, month, db)) !== null;
}

/** Create (review #1679 L2), calculate and approve (delta M2): no off-cycle run of a month whose EMP201 is filed. */
export async function offCycleFiledMonthRefusal(companyId: string, run: RunFacts, db: TxSql = sql): Promise<string | null> {
  if (run.run_kind !== 'off_cycle') return null;
  const year = Number(run.period_year);
  const month = Number(run.period_month);
  return (await emp201FiledForMonth(companyId, year, month, db))
    ? `The EMP201 for ${year}-${String(month).padStart(2, '0')} is filed, so an off-cycle run of that month is not created, `
      + 'calculated or approved: the filed declaration stands. A correction after filing is made outside payroll for now.'
    : null;
}

/**
 * The pay date as the 999x trigger froze it at the run's first approval (off_cycle_payday_at, the start of the next
 * day in South Africa), 'YYYY-MM-DD'; null when none was frozen. South Africa keeps no daylight saving: UTC+2.
 */
export function frozenPayDate(run: RunFacts): string | null {
  if (run.off_cycle_payday_at == null) return null;
  const end = new Date(run.off_cycle_payday_at instanceof Date ? run.off_cycle_payday_at.getTime() : String(run.off_cycle_payday_at));
  if (Number.isNaN(end.getTime())) return null;
  return new Date(end.getTime() + 2 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Each employee's gross approved for payment on this run (999x payroll_run_headers.off_cycle_paid_gross, taken by the
 * snapshot trigger when the run left 'approved'), once its pay date has passed; null otherwise. The pay date is the one
 * frozen at the first approval (ruling on review #1679: as the trigger reads it, never run_date).
 */
function paidCaps(run: RunFacts, today: string): Map<string, number> | null {
  if (run.run_kind !== 'off_cycle') return null;
  const payDate = frozenPayDate(run);
  // Fail closed: approved before but no frozen payday (lost below the service): every employee capped at nil.
  if (payDate === null) return wasApprovedBefore(run.approval_history) ? new Map() : null;
  if (payDate >= today) return null;
  // Fail closed (review #1679c): a run approved before has a snapshot (the reopen takes one from its lines); none means
  // it was lost below the service (a header deleted and inserted again), so every employee is capped at nil.
  if (run.off_cycle_paid_gross == null) return wasApprovedBefore(run.approval_history) ? new Map() : null;
  const snap = (typeof run.off_cycle_paid_gross === 'string' ? JSON.parse(run.off_cycle_paid_gross) : run.off_cycle_paid_gross) as Record<string, unknown>;
  return new Map(Object.entries(snap).map(([k, v]) => [k, Number(v)]));
}

/** The refusal: the frozen pay date, or (no payday recorded, every cap nil) that, never a date read from run_date. */
const raisedMessage = (run: RunFacts, cap: number) => {
  const payDate = frozenPayDate(run);
  return payDate === null
    ? `This run was approved before but has no recorded payday, so an employee's pay on it can't be raised (last approved `
      + `${formatMoney(cap)}). Pay the difference in a new off-cycle run.`
    : `This run was paid on ${formatDisplayDate(payDate)}, so an employee's pay on it can't be raised after the pay date (last `
      + `approved ${formatMoney(cap)}). Pay the difference in a new off-cycle run.`;
};

/** The bonus amount edit (delta M1): `amount` (the bonus line's gross) would raise a paid gross. Null when it does not. */
export function offCycleRaiseRefusal(run: RunFacts, employeeId: string, amount: number, today: string = todayInSast()): string | null {
  const caps = paidCaps(run, today);
  if (!caps) return null;
  const cap = caps.get(employeeId) ?? 0;
  return amount > cap + 0.004 ? raisedMessage(run, cap) : null;
}

/**
 * Approval (review #1679 M): after its pay date, no employee's gross on a reopened off-cycle run (bonus or
 * termination) rises above what was last approved; an employee who was not paid then counts as nil.
 */
export async function offCycleRaisedAfterPayRefusal(
  companyId: string, run: RunFacts, db: TxSql = sql, today: string = todayInSast(),
): Promise<string | null> {
  const caps = paidCaps(run, today);
  if (!caps) return null;
  const now = (await db`
    SELECT l.employee_id::text AS employee_id, SUM(l.gross_pay)::float8 AS gross
      FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid AND h.id = ${String(run.id)}::uuid
     GROUP BY l.employee_id
  `) as DbRow[];
  for (const r of now) {
    const cap = caps.get(String(r.employee_id)) ?? 0;
    if (Number(r.gross) > cap + 0.004) return raisedMessage(run, cap);
  }
  return null;
}
