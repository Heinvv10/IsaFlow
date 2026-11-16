/**
 * Payroll for the forecast (ruling 2026-11-16): net pay is the latest approved or paid run's `total_net`
 * (payroll_run_headers; the statuses EMP201 declares), paid monthly on the pay day. A month whose run is
 * already paid is not paid again. No such run → no line (the service warns).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { payDatesInHorizon, type PayDay } from './payDates';
import { toCents } from './lines';
import type { KnownItem } from './types';

export interface LatestPayRun {
  id: string;
  period: string;
  netCents: number;
  /** PAYE net of ETI (never below 0) + UIF + SDL: what that run's EMP201 remits, for a month not yet run. */
  statutoryCents: number;
}

export interface PayrollRead {
  latest: LatestPayRun | null;
  /** 'YYYY-MM' periods with a run already paid. */
  paidMonths: Set<string>;
}

const period = (r: DbRow) => `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`;

export async function readPayroll(companyId: string): Promise<PayrollRead> {
  const statuses: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT id, period_year, period_month, status, total_net, total_paye, total_eti, total_uif, total_sdl
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::UUID AND status = ANY(${statuses}::text[])
    ORDER BY period_year DESC, period_month DESC
  `) as DbRow[];
  const head = rows[0];
  const latest: LatestPayRun | null = head ? {
    id: String(head.id),
    period: period(head),
    netCents: toCents(String(head.total_net)),
    statutoryCents: Math.max(0, toCents(String(head.total_paye)) - toCents(String(head.total_eti)))
      + toCents(String(head.total_uif)) + toCents(String(head.total_sdl)),
  } : null;
  return { latest, paidMonths: new Set(rows.filter((r) => r.status === 'paid').map(period)) };
}

export function payrollItems(read: PayrollRead, payDay: PayDay, today: string, horizonEnd: string): KnownItem[] {
  const latest = read.latest;
  if (!latest || latest.netCents <= 0) return [];
  return payDatesInHorizon(payDay, today, horizonEnd, read.paidMonths).map((date) => ({
    lineKey: 'payroll:net', lineLabel: 'Salaries and wages (net pay)', category: 'payroll' as const,
    date, amountCents: -latest.netCents, ref: `${latest.id}:${date}`, refLabel: `Net pay of the ${latest.period} run`,
  }));
}
