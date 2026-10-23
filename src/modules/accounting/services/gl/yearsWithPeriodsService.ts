/**
 * Financial Years page data: every stored financial year with its periods.
 * The year's own dates come from the registry (fiscalYearRegistry.ts); the
 * periods are read here by fiscal_year_id, never by label, so a transition
 * year and its neighbours never mix.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { FiscalPeriodStatus } from '../../types/gl.types';
import { listFiscalYears, type FiscalYearRecord } from './fiscalYearRegistry';

export interface YearPeriod {
  id: string;
  periodName: string;
  periodNumber: number;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
}

export interface YearWithPeriods extends FiscalYearRecord {
  periods: YearPeriod[];
}

export async function listYearsWithPeriods(companyId: string): Promise<YearWithPeriods[]> {
  const years = await listFiscalYears(companyId);
  return Promise.all(years.map(async (year) => {
    const rows = (await sql`
      SELECT id, period_name, period_number, fiscal_year, start_date, end_date, status
        FROM fiscal_periods
       WHERE company_id = ${companyId}::UUID AND fiscal_year_id = ${year.id}::UUID
       ORDER BY start_date
    `) as DbRow[];
    const periods = rows.map((r): YearPeriod => ({
      id: String(r.id),
      periodName: String(r.period_name),
      periodNumber: Number(r.period_number),
      fiscalYear: Number(r.fiscal_year),
      startDate: fmtDate(r.start_date),
      endDate: fmtDate(r.end_date),
      status: String(r.status) as FiscalPeriodStatus,
    }));
    return { ...year, periods };
  }));
}
