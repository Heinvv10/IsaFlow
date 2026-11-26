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
import { creditorShortfall, fileSettlement } from '@/modules/accounting/services/payroll/payrollBankFileSettlement';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import {
  expectedVatPeriodAsOf,
  normalizeVatAlignment,
  normalizeVatSetting,
  type VatPeriod,
} from './vatPeriodHelper';
import { todayInSast } from '@/lib/saDateParser';
import { MONTHS, PAY_RUN_WINDOW_MONTHS_BACK } from './bureauWorkTypes';
import { pickPayrollRun, type CashPositionPayroll, type PayrollRunRow } from './ownerCashPayrollPick';

export { PAY_RUN_WINDOW_MONTHS_BACK };
export { pickPayrollRun, shapePayrollAffordability } from './ownerCashPayrollPick';
export type { CashPositionPayroll, PayrollRunRow } from './ownerCashPayrollPick';

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
           paid_on::text AS paid_on,
           (SELECT min(f.action_date)::text FROM payroll_bank_files f
             WHERE f.company_id = payroll_run_headers.company_id AND f.run_id = payroll_run_headers.id AND f.status = 'confirmed') AS bank_paid_on,
           (SELECT f.id::text FROM payroll_bank_files f
             WHERE f.company_id = payroll_run_headers.company_id AND f.run_id = payroll_run_headers.id AND f.status = 'confirmed') AS bank_file_id,
           (SELECT COALESCE(sum(d.amount), 0) FROM payroll_garnishee_deductions d
             WHERE d.company_id = payroll_run_headers.company_id AND d.run_id = payroll_run_headers.id) AS garnishee,
           (SELECT sum(v::numeric) FROM jsonb_each_text(off_cycle_paid_gross) AS g(k, v)) AS paid_gross
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND (status IN ('draft','calculated','approved') OR ${sql.unsafe(payRunFinalSql('payroll_run_headers'))})
       AND (period_year * 12 + period_month) BETWEEN ${cur - PAY_RUN_WINDOW_MONTHS_BACK}::int AND ${cur}::int
     ORDER BY ${runOrderKeySql('payroll_run_headers')}
  `) as unknown as PayrollRunRow[];
  // What each confirmed file left unpaid (GC2 / review #1524 D-3): the creditors, and the employees of a re-approved run. One query at a time (one request transaction).
  for (const r of rows) {
    if (r.bank_file_id == null) continue;
    r.creditor_short = (await creditorShortfall(companyId, r.id, r.bank_file_id)).reduce((t, c) => t + Math.max(0, c.cents), 0) / 100;
    r.employee_owed = (await fileSettlement(companyId, r.id, r.bank_file_id)).owedCents / 100;
  }
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
  /** Required: the payroll section (pay runs, what they need) is read only for `payroll: true`, a caller with Payroll read. */
  sections: { payroll: boolean },
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
    sections.payroll ? soft<CashPositionPayroll | null>('payroll', null, () => nextPayrollSection(companyId, cash, asAt)) : Promise.resolve(null),
    soft<CashPositionVat | null>('vat', null, () => vatSection(companyId, today)),
  ]);

  return { cash, payroll, vat };
}
