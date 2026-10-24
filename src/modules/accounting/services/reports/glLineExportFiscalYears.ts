/**
 * The financial year of each export row, from the fiscal-year registry.
 *
 * `toExportRow` is pure and synchronous, so the years are resolved here, once
 * per page, and ride on the row (`fy_label`, `fy_period_no`). A page spans a
 * handful of years at most, so the registry is asked once per distinct year,
 * not once per line: a date already inside a resolved year reuses it.
 *
 * FY is named by the calendar year the year ENDS in (the registry's label). The
 * period number counts whole calendar months from the year's start, so a
 * 14-month transition year runs 1 to 14.
 */

import type { DbRow } from '@/types/db';
import {
  fiscalYearForDate,
  monthsSpanned,
  type FiscalYearRecord,
} from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { isoDate } from './glLineExportRows';

/** Rows with `fy_label` ('FY26') and `fy_period_no` set from the registry year holding `entry_date`. */
export async function withFiscalYears(companyId: string, rows: DbRow[]): Promise<DbRow[]> {
  const years: FiscalYearRecord[] = [];
  const out: DbRow[] = [];
  // SEQUENTIAL: every read runs on the one pg client the request transaction holds.
  for (const r of rows) {
    const date = isoDate(r.entry_date);
    let year = years.find((y) => date >= y.startDate && date <= y.endDate);
    if (!year) {
      year = await fiscalYearForDate(companyId, date);
      years.push(year);
    }
    out.push({
      ...r,
      fy_label: `FY${String(year.fiscalYear % 100).padStart(2, '0')}`,
      fy_period_no: monthsSpanned(year.startDate, date),
    });
  }
  return out;
}
