/**
 * Owner cash position for the direct-client /home page (Workstream G).
 *
 * Answers three plain-language questions for a business owner:
 *  - "Can I pay salaries?"  — cash vs the next unpaid payroll run's full outflow
 *  - "Who owes me?"         — top AR debtors (reuses getDebtorsSummary)
 *  - "VAT set-aside"        — current expected VAT period's net liability
 *
 * Sections are advisory estimates: each is computed fail-soft (null on error,
 * log.warn) so a broken estimate never takes down the owner's landing page.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getDebtorsSummary, type DebtorSummary } from '@/modules/accounting/services/ar/debtorsManagerService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import {
  expectedVatPeriodAsOf,
  normalizeVatAlignment,
  normalizeVatCadence,
  type VatPeriod,
} from './vatPeriodHelper';
import { MONTHS } from './bureauWorkTypes';

export interface PayrollRunRow {
  id: string;
  period_month: number;
  period_year: number;
  status: string;
  total_net: string | number | null;
  total_paye: string | number | null;
  total_uif: string | number | null;
  total_sdl: string | number | null;
  total_eti: string | number | null;
}

export interface CashPositionPayroll {
  runId: string;
  periodLabel: string;
  status: 'approved' | 'estimated';
  totalRequired: number;
  canPay: boolean;
  shortfall: number;
}

export interface CashPositionDebtor {
  clientId: string;
  clientName: string;
  totalOutstanding: number;
  overdue: number;
}

export interface CashPositionVat {
  periodLabel: string;
  dueDate: string;
  netVat: number;
}

export interface OwnerCashPosition {
  cash: number;
  payroll: CashPositionPayroll | null;
  topDebtors: CashPositionDebtor[];
  arTotal: number;
  vat: CashPositionVat | null;
}

const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v)) || 0;

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
    shortfall: canPay ? 0 : Math.round((totalRequired - cash) * 100) / 100,
  };
}

export function shapeTopDebtors(
  summary: DebtorSummary[],
): { topDebtors: CashPositionDebtor[]; arTotal: number } {
  return {
    topDebtors: summary.slice(0, 3).map((d) => ({
      clientId: d.clientId,
      clientName: d.clientName,
      totalOutstanding: d.totalOutstanding,
      overdue: d.days30 + d.days60 + d.days90 + d.days90Plus,
    })),
    arTotal: summary.reduce((s, d) => s + d.totalOutstanding, 0),
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

// ── Private section helpers ───────────────────────────────────────────────────

async function nextPayrollSection(
  companyId: string,
  cash: number,
): Promise<CashPositionPayroll | null> {
  const rows = (await sql`
    SELECT id, period_month, period_year, status,
           total_net, total_paye, total_uif, total_sdl, total_eti
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND status IN ('draft','calculated','approved')
     ORDER BY period_year, period_month
     LIMIT 1
  `) as unknown as PayrollRunRow[];
  return shapePayrollAffordability(rows[0] ?? null, cash);
}

async function debtorsSection(
  companyId: string,
): Promise<{ topDebtors: CashPositionDebtor[]; arTotal: number }> {
  return shapeTopDebtors(await getDebtorsSummary(companyId));
}

async function vatSection(companyId: string, today: Date): Promise<CashPositionVat | null> {
  const rows = (await sql`
    SELECT vat_period_alignment, vat_period FROM companies WHERE id = ${companyId}::uuid
  `) as unknown as Array<{ vat_period_alignment: string | null; vat_period: string | null }>;
  if (!rows[0]) return null;
  const period = expectedVatPeriodAsOf(
    normalizeVatAlignment(rows[0].vat_period_alignment),
    today,
    normalizeVatCadence(rows[0].vat_period),
  );
  const ret = await getVATReturn(companyId, period.periodStart, period.periodEnd);
  return shapeVatSetAside(ret.netVAT, period);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Each section is an advisory estimate: failures are logged and degrade to
 * null/empty rather than failing the whole /home payload.
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
        },
        'owner-cash-position',
      );
      return fallback;
    }
  };

  const [payroll, debtors, vat] = await Promise.all([
    soft<CashPositionPayroll | null>('payroll', null, () => nextPayrollSection(companyId, cash)),
    soft('debtors', { topDebtors: [] as CashPositionDebtor[], arTotal: 0 }, () =>
      debtorsSection(companyId),
    ),
    soft<CashPositionVat | null>('vat', null, () => vatSection(companyId, today)),
  ]);

  return { cash, payroll, topDebtors: debtors.topDebtors, arTotal: debtors.arTotal, vat };
}
