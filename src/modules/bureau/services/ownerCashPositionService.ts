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
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import {
  expectedVatPeriodAsOf,
  normalizeVatAlignment,
  normalizeVatSetting,
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
 * Which run of the window to report. A run whose pay date is today or later is STILL DUE, and cash pays the due runs
 * in pay order: each is judged against what the due runs before it left (review #1549 L1), so `totalRequired` is the
 * due runs up to and including it and `runsCounted` how many. A run whose pay date has passed is judged on its own, as
 * before: nothing marks a run paid (no writer sets 'paid'; a bank-file confirmation exists only where the platform
 * flag is on), so last month's approved run still sits in the window after its salaries left the bank, and adding it
 * would report a false shortfall (review #1549 N-H1). The first run cash cannot cover is reported; when every run is
 * covered, the latest run with totals. A run with no totals yet (a draft) needs nothing and never hides a shortfall
 * on another run; with no totals at all, the earliest run. No `asAt`: every run is due.
 */
export function pickPayrollRun(runs: PayrollRunRow[], cash: number, asAt?: string): CashPositionPayroll | null {
  const due = (r: PayrollRunRow): boolean => asAt === undefined || r.pay_date == null || String(r.pay_date).slice(0, 10) >= asAt;
  let required = 0;
  let counted = 0;
  let latest: CashPositionPayroll | null = null;
  for (const r of runs) {
    const own = shapePayrollAffordability(r, cash)!;
    if (own.totalRequired <= 0) continue;
    let judged = own;
    if (due(r)) {
      required = r2(required + own.totalRequired);
      counted += 1;
      judged = { ...own, totalRequired: required, canPay: cash >= required, shortfall: cash >= required ? 0 : r2(required - cash), runsCounted: counted };
    }
    if (!judged.canPay) return judged;
    latest = judged;
  }
  return latest ?? (runs[0] ? shapePayrollAffordability(runs[0], cash) : null);
}

// ── Private section helpers ───────────────────────────────────────────────────

/**
 * The open runs of `asAt`'s month and the month before: a forgotten 2020 run is not "the next" one. In pay order
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
           COALESCE(run_date, period_end)::text AS pay_date
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND status IN ('draft','calculated','approved')
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
