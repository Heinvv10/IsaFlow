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
 * Which run of the window to report. Cash pays the runs in pay order, so each run is judged against what the runs
 * before it left (review #1549 L1: never the whole balance once per run). The first run the remainder cannot cover is
 * reported, its `totalRequired` the runs up to and including it and its shortfall that sum less cash; when every run
 * is covered, the latest run with totals, against all of them. A run with no totals yet (a draft) needs nothing and
 * never hides a shortfall on another run; with no totals at all, the earliest run.
 */
export function pickPayrollRun(runs: PayrollRunRow[], cash: number): CashPositionPayroll | null {
  const shaped = runs.map((r) => shapePayrollAffordability(r, cash)!);
  const withTotals = shaped.filter((p) => p.totalRequired > 0);
  let required = 0;
  for (const [i, p] of withTotals.entries()) {
    required = r2(required + p.totalRequired);
    if (cash < required) return { ...p, totalRequired: required, canPay: false, shortfall: r2(required - cash), runsCounted: i + 1 };
  }
  const last = withTotals[withTotals.length - 1];
  if (last) return { ...last, totalRequired: required, canPay: true, shortfall: 0, runsCounted: withTotals.length };
  return shaped[0] ?? null;
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
           total_net, total_paye, total_uif, total_sdl, total_eti
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND status IN ('draft','calculated','approved')
       AND (period_year * 12 + period_month) BETWEEN ${cur - PAY_RUN_WINDOW_MONTHS_BACK}::int AND ${cur}::int
     ORDER BY ${runOrderKeySql('payroll_run_headers')}
  `) as unknown as PayrollRunRow[];
  return pickPayrollRun(rows, cash);
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
