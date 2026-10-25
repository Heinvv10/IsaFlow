/**
 * Fiscal years for integration fixtures, built the way the product builds them.
 *
 * Fixtures used to INSERT one catch-all "period" ('2020-01-01' to some day
 * next year) so every date had a period. Migration 940 refuses that: a year is
 * at most 15 months and years never overlap. This seeds the real thing instead
 * — every template year holding a day in the range, each with all its monthly
 * periods — through the product's own generator (gl/fiscalYearGenerator.ts).
 * All values are synthetic.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';

/** Every fiscal year holding a day from `from` to `to`, each with all of its monthly periods. */
export async function seedFiscalYears(companyId: string, from: string, to: string): Promise<void> {
  let day = from;
  while (day <= to) {
    const { fiscalYearId } = await generateFiscalYearForDate(companyId, day);
    const rows = (await sql`SELECT end_date FROM fiscal_years WHERE id = ${fiscalYearId}::UUID`) as DbRow[];
    const next = new Date(`${fmtDate(rows[0]!.end_date as string | Date)}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
}

/** Close (or re-open) every period of the company that ends on or before `date`. */
export async function setPeriodsEndingBy(companyId: string, date: string, status: 'open' | 'closed'): Promise<void> {
  await sql`UPDATE fiscal_periods SET status = ${status}
            WHERE company_id = ${companyId}::UUID AND end_date <= ${date}::date`;
}
