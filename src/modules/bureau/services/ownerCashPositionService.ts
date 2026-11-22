/**
 * Owner cash position, read by the dashboard's "Needs attention" list
 * (accounting/services/dashboard/attentionService).
 *
 * Answers two plain-language questions for a business owner:
 *  - "Can I pay salaries?": cash vs the full outflow of each open payroll run
 *    of this SAST month or the month before (never an older one); see
 *    pickPayrollRun for which run is reported
 *  - "VAT set-aside": the current expected VAT period's net liability
 *
 * Sections are advisory estimates: each is computed fail-soft (null on error,
 * log.warn) so a broken estimate never takes down the dashboard.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runOrderKeySql } from '@/modules/accounting/services/payroll/payrollRunOrder';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { approvalCoveredPaydaySql } from '@/modules/accounting/services/payroll/payrollPaydayCover';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import {
  expectedVatPeriodAsOf,
  normalizeVatAlignment,
  normalizeVatSetting,
  previousBusinessDay,
  type VatPeriod,
} from './vatPeriodHelper';
import { todayInSast } from '@/lib/saDateParser';
import { MONTHS, PAY_RUN_WINDOW_MONTHS_BACK } from './bureauWorkTypes';

export { PAY_RUN_WINDOW_MONTHS_BACK };

export interface PayrollRunRow {
  id: string;
  period_month: number;
  period_year: number;
  status: string;
  total_net: string | number;
  total_paye: string | number;
  total_uif: string | number;
  total_sdl: string | number;
  total_eti: string | number;
  /** The run's pay date, COALESCE(run_date, period_end) as YYYY-MM-DD; absent means still due. */
  pay_date?: string | null;
  /** Final (payRunFinalSql): only a final run past its pay date has been paid (review #1679 M3); absent = not final. */
  final?: boolean;
  /**
   * Review M1 of e9f437f366: an approval of the run overlapped its payday, the SAST day of its pay date (approval_history,
   * approvalCoveredPaydaySql), so its salaries were disbursed even if it has since been reopened; its gross, and an off-cycle run's paid gross (999x snapshot).
   */
  disbursed?: boolean;
  total_gross?: string | number;
  paid_gross?: string | number | null;
}

export interface CashPositionPayroll {
  runId: string;
  periodLabel: string;
  status: 'approved' | 'estimated';
  totalRequired: number;
  canPay: boolean;
  shortfall: number;
  /** The open runs `totalRequired` adds up: this run and every earlier one (pickPayrollRun). */
  runsCounted: number;
}

export interface CashPositionVat {
  periodLabel: string;
  dueDate: string;
  netVat: number;
}

export interface OwnerCashPosition {
  cash: number;
  payroll: CashPositionPayroll | null;
  vat: CashPositionVat | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Null/undefined branch is defensive only — payroll money columns are NOT NULL DEFAULT 0 (migration 382). */
const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v)) || 0;

// Deliberately local, not shared: the plain-language payroll label wants full month names, while the VAT label matches the bureau short-form via MONTHS.
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

// ── Pure shapers ──────────────────────────────────────────────────────────────

export function shapePayrollAffordability(
  run: PayrollRunRow | null,
  cash: number,
): CashPositionPayroll | null {
  if (!run) return null;
  const totalRequired =
    num(run.total_net) + num(run.total_paye) + num(run.total_uif) + num(run.total_sdl) - num(run.total_eti);
  const canPay = cash >= totalRequired;
  return {
    runId: run.id,
    periodLabel: `${MONTH_FULL[run.period_month - 1]!} ${run.period_year}`,
    status: run.status === 'approved' ? 'approved' : 'estimated',
    totalRequired,
    canPay,
    shortfall: canPay ? 0 : r2(totalRequired - cash),
    runsCounted: 1,
  };
}

export function shapeVatSetAside(netVat: number, period: VatPeriod): CashPositionVat {
  const s = new Date(`${period.periodStart}T00:00:00Z`);
  const e = new Date(`${period.periodEnd}T00:00:00Z`);
  const sameMonth =
    s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const periodLabel = sameMonth
    ? `${MONTHS[e.getUTCMonth()]!} ${e.getUTCFullYear()}`
    : `${MONTHS[s.getUTCMonth()]!}–${MONTHS[e.getUTCMonth()]!} ${e.getUTCFullYear()}`;
  return { periodLabel, dueDate: period.dueDate, netVat };
}

/**
 * Which run of the window to report. Cash pays runs by PAY DATE (review #1679 codex 3), whatever order costs them
 * (runOrderKeySql puts a regular run before its month's off-cycle runs): rows are taken in pay-date order, the given
 * order breaking ties. A run whose pay date is today or later is STILL DUE: each is judged against what the due runs
 * before it left (review #1549 L1), so `totalRequired` is the due runs up to and including it and `runsCounted` how many.
 * Each run counts what it still needs (owedOf): a run paid on its pay date (final, or reopened after it) needs only its
 * statutory amounts until its EMP201 is due, and a reopened bonus the gross above what was paid; a run that needs
 * nothing more is reported only when no run needs anything, as covered (review #1679 codex 4). ACCEPTED LIMIT (review L1
 * of ed7bdab53e, wave 7 "regular-run paid snapshot"): a REGULAR run reopened after payday and recalculated higher owes
 * only its statutory amounts here, as regular runs keep no paid snapshot (999x snapshots off-cycle runs only). The first due run cash cannot cover is reported; when every due run is covered, the latest one (its
 * cumulative figure). A run with no totals yet (a draft) needs nothing and never hides a shortfall on another run; with
 * no totals at all, the earliest run. No `asAt`: every run is due.
 */
/**
 * The day a month's EMP201 is due: the 7th of the next month, moved back to the business day before when it falls on a
 * weekend or SA public holiday (previousBusinessDay, as the compliance calendar does). After it the 13-week forecast
 * assumes it paid (readSars).
 */
const emp201Due = (r: PayrollRunRow): string =>
  (r.period_month === 12 ? previousBusinessDay(r.period_year + 1, 1, 7) : previousBusinessDay(r.period_year, r.period_month + 1, 7));

/**
 * What a run still needs from cash on `asAt` (gate rulings 4 and 5 on 7630d9379f). Before its pay date, or overdue and
 * neither final nor disbursed (review #1679 M3): all of it. Once its pay date has passed and it was paid (final, or an
 * approval that overlapped its payday, since reopened): payday settled the net pay, so it needs its PAYE (less ETI, never
 * below nil), UIF and SDL until the
 * month's EMP201 is due, and a reopened off-cycle run also the gross above its paid snapshot (999x off_cycle_paid_gross).
 */
function owedOf(r: PayrollRunRow, asAt: string | undefined): { owed: number; paye: number; credit: number; paid: boolean } {
  // ETI offsets PAYE only (gate ruling 2 on e0eec1dea1): PAYE less ETI, floored at nil; what ETI leaves beyond PAYE is a
  // credit against the month's other PAYE. UIF and SDL stay owed in full.
  const payeNet = r2(num(r.total_paye) - num(r.total_eti));
  const paye = Math.max(0, payeNet);
  const credit = Math.min(0, payeNet);
  const other = r2(num(r.total_uif) + num(r.total_sdl));
  // Marked paid (gate item 3 on 06c106a94d): its net pay has left, whatever its pay date says.
  const paid = r.status === 'paid'
    || (asAt !== undefined && r.pay_date != null && String(r.pay_date).slice(0, 10) < asAt && (r.final === true || r.disbursed === true));
  if (!paid) return { owed: r2(num(r.total_net) + paye + other), paye, credit, paid };
  const above = r.final !== true && r.paid_gross != null ? Math.max(0, r2(num(r.total_gross) - num(r.paid_gross))) : 0;
  if (asAt !== undefined && asAt > emp201Due(r)) return { owed: above, paye: 0, credit: 0, paid };
  return { owed: r2(paye + other + above), paye, credit, paid };
}

export function pickPayrollRun(runs: PayrollRunRow[], cash: number, asAt?: string): CashPositionPayroll | null {
  const payDate = (r: PayrollRunRow): string => (r.pay_date == null ? '\uffff' : String(r.pay_date).slice(0, 10));
  const byPayDate = runs.map((r, i) => ({ r, i }))
    .sort((a, b) => (payDate(a.r) < payDate(b.r) ? -1 : payDate(a.r) > payDate(b.r) ? 1 : a.i - b.i)).map((x) => x.r);
  // A paid run's statutory figure can be negative (ETI above its PAYE, UIF and SDL): the month's EMP201 nets it, so it
  // is a credit against the statutory part of the month's other runs, never dropped (review L2 of ed7bdab53e; never
  // against net pay, F1 of 3401802134). Another month's is not.
  const monthOf = (r: PayrollRunRow) => `${r.period_year}-${r.period_month}`;
  const owedBy = new Map(runs.map((r) => [r, owedOf(r, asAt)] as const));
  const credit = new Map<string, number>();
  for (const [r, { credit: c }] of owedBy) if (c < 0) credit.set(monthOf(r), r2((credit.get(monthOf(r)) ?? 0) + c));
  let required = 0;
  let counted = 0;
  let latestPaid: CashPositionPayroll | null = null;
  let latestDue: CashPositionPayroll | null = null;
  for (const r of byPayDate) {
    const full = shapePayrollAffordability(r, cash)!;
    const { owed: owes, paye, paid } = owedBy.get(r)!;
    // Judged on what it owes (owedOf: ETI off PAYE only, review L1 of f37f0f15a6), never on the whole run netted: a run
    // not paid that owes nothing (a draft with no totals) needs nothing and hides nothing.
    if (!paid && owes <= 0) continue;
    let owed = owes;
    const left = credit.get(monthOf(r)) ?? 0;
    // Against the run's PAYE only: ETI offsets PAYE, never net pay, UIF or SDL (review F1 of 3401802134, gate ruling 2).
    if (owed > 0 && left < 0 && paye > 0) {
      const used = Math.max(left, -Math.min(owed, paye));
      owed = r2(owed + used);
      credit.set(monthOf(r), r2(left - used));
    }
    if (owed <= 0) { latestPaid = { ...full, totalRequired: 0, canPay: true, shortfall: 0, runsCounted: 0 }; continue; }
    const own = { ...full, totalRequired: owed };
    required = r2(required + owed);
    counted += 1;
    const judged = { ...own, totalRequired: required, canPay: cash >= required, shortfall: cash >= required ? 0 : r2(required - cash), runsCounted: counted };
    if (!judged.canPay) return judged;
    latestDue = judged;
  }
  if (latestDue || latestPaid) return latestDue ?? latestPaid;
  const first = runs[0];
  if (!first) return null;
  const owedFirst = Math.max(0, owedBy.get(first)!.owed);
  return { ...shapePayrollAffordability(first, cash)!, totalRequired: owedFirst, canPay: cash >= owedFirst, shortfall: cash >= owedFirst ? 0 : r2(owedFirst - cash) };
}

// ── Private section helpers ───────────────────────────────────────────────────

/**
 * The open runs of `asAt`'s month and the month before, and its final ones (a run marked paid still owes its PAYE, UIF
 * and SDL until the EMP201 is due, owedOf; review of fd9193cc2): a forgotten 2020 run is not "the next" one. In pay order
 * (runOrderKeySql, wave 6 FQb2), so "earliest" and "latest" name one run when a month holds several.
 */
async function nextPayrollSection(
  companyId: string,
  cash: number,
  asAt: string,
): Promise<CashPositionPayroll | null> {
  const cur = Number(asAt.slice(0, 4)) * 12 + Number(asAt.slice(5, 7));
  const rows = (await sql`
    SELECT id, period_month, period_year, status,
           total_net, total_paye, total_uif, total_sdl, total_eti,
           COALESCE(run_date, period_end)::text AS pay_date,
           ${sql.unsafe(payRunFinalSql('payroll_run_headers'))} AS final,
           total_gross, ${sql.unsafe(approvalCoveredPaydaySql('payroll_run_headers'))} AS disbursed,
           (SELECT sum(v::numeric) FROM jsonb_each_text(off_cycle_paid_gross) AS g(k, v)) AS paid_gross
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND (status IN ('draft','calculated','approved') OR ${sql.unsafe(payRunFinalSql('payroll_run_headers'))})
       AND (period_year * 12 + period_month) BETWEEN ${cur - PAY_RUN_WINDOW_MONTHS_BACK}::int AND ${cur}::int
     ORDER BY ${runOrderKeySql('payroll_run_headers')}
  `) as unknown as PayrollRunRow[];
  return pickPayrollRun(rows, cash, asAt);
}

async function vatSection(companyId: string, today: Date): Promise<CashPositionVat | null> {
  const rows = (await sql`
    SELECT vat_period_alignment, vat_period, vat_system_type FROM companies WHERE id = ${companyId}::uuid
  `) as unknown as Array<{ vat_period_alignment: string | null; vat_period: string | null; vat_system_type: string | null }>;
  if (!rows[0]) return null;
  // Non-vendors set nothing aside for VAT — the section is omitted entirely.
  const setting = normalizeVatSetting(rows[0].vat_period, rows[0].vat_system_type);
  if (setting === 'none') return null;
  const period = expectedVatPeriodAsOf(
    normalizeVatAlignment(rows[0].vat_period_alignment),
    today,
    setting,
  );
  const ret = await getVATReturn(companyId, period.periodStart, period.periodEnd);
  return shapeVatSetAside(ret.netVAT, period);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Each section is an advisory estimate: failures are logged and degrade to
 * null rather than failing the whole attention list.
 */
export async function getOwnerCashPosition(
  companyId: string,
  cash: number,
  today: Date,
): Promise<OwnerCashPosition> {
  const soft = async <T>(section: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.warn(
        'ownerCashPosition section failed — degrading',
        {
          companyId,
          section,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'owner-cash-position',
      );
      return fallback;
    }
  };

  const asAt = todayInSast(today);
  const [payroll, vat] = await Promise.all([
    soft<CashPositionPayroll | null>('payroll', null, () => nextPayrollSection(companyId, cash, asAt)),
    soft<CashPositionVat | null>('vat', null, () => vatSection(companyId, today)),
  ]);

  return { cash, payroll, vat };
}
