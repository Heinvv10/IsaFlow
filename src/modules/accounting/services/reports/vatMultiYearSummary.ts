/** Multi-year VAT summary (split from vatReconciliationService). */

import { sql } from '@/lib/neon';
import { VAT_SUBMISSION_CLEARING_SOURCE } from './vatSubmissionClearing';
import { r2, toNum } from './vatReconNumbers';
import { vatPeriodFilings } from '../returns/vatPeriodFilings';

type DbRow = Record<string, unknown>;

// ── Multi-year VAT summary ──────────────────────────────────────────────────

export interface VatYearSummary {
  year: number;
  totalOutputVat: number;
  totalInputVat: number;
  netVat: number;
  totalRevenue: number;
  effectiveRate: number;
  returnsSubmitted: number;
  returnsExpected: number;
}

export async function getVatMultiYearSummary(
  companyId: string,
  years: number = 3,
): Promise<VatYearSummary[]> {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years + 1;

  const [glRows, returnRows] = await Promise.all([
    sql`
      SELECT
        EXTRACT(YEAR FROM gje.entry_date)::INT AS year,
        -- Net, per gl_revenue above: same per-line ABS, same fix.
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue'
          THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_output'
          THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS output_vat,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_input'
          THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS input_vat
      FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      WHERE gjl.company_id = ${companyId}
        AND gje.status = 'posted'
        AND EXTRACT(YEAR FROM gje.entry_date) >= ${startYear}
        -- V-05, same predicate and same reason as the monthly query above: the
        -- clearing journal for every filed period falls inside the years this
        -- summary spans, so without it each year's output and input tax netted
        -- itself away and the multi-year trend was the settlement schedule, not
        -- the trade. Revenue is unaffected — the clearing journal posts no
        -- revenue line. IS DISTINCT FROM, not <>: source is nullable.
        AND gje.source IS DISTINCT FROM ${VAT_SUBMISSION_CLEARING_SOURCE}
        -- Ledger basis throughout: nothing here is compared with documents, and
        -- the rate divides VAT by revenue on ONE basis (D7 round 3).
        AND (ga.account_type = 'revenue' OR ga.account_subtype IN ('vat_output', 'vat_input'))
      GROUP BY EXTRACT(YEAR FROM gje.entry_date)
      ORDER BY year
    ` as Promise<DbRow[]>,
    // Returns submitted per year, by the year the period starts: the lifecycle's filed or settled VAT201, else the
    // legacy vat_returns row (vatPeriodFilings).
    vatPeriodFilings([companyId], { from: `${startYear}-01-01`, to: '9999-12-31' }).then((filings) => {
      const byYear = new Map<number, number>();
      for (const f of filings) {
        const year = Number(f.periodStart.slice(0, 4));
        if (f.submitted && year >= startYear) byYear.set(year, (byYear.get(year) ?? 0) + 1);
      }
      return [...byYear].map(([year, n]): DbRow => ({ year, returns_submitted: n }));
    }),
  ]);

  const retMap = new Map(returnRows.map((r) => [Number(r.year), Number(r.returns_submitted)]));

  return glRows.map((r) => {
    const year = Number(r.year);
    const totalRevenue = toNum(r.revenue);
    const totalOutputVat = toNum(r.output_vat);
    const totalInputVat = toNum(r.input_vat);
    const netVat = r2(totalOutputVat - totalInputVat);
    const effectiveRate = totalRevenue > 0 ? r2((totalOutputVat / totalRevenue) * 100) : 0;
    const returnsSubmitted = retMap.get(year) ?? 0;
    // VAT returns are typically bimonthly (6 per year) but can be monthly (12)
    const returnsExpected = year === currentYear
      ? new Date().getMonth() + 1 // months elapsed
      : 12;

    return {
      year, totalOutputVat, totalInputVat, netVat,
      totalRevenue, effectiveRate, returnsSubmitted,
      returnsExpected: Math.ceil(returnsExpected / 2), // bimonthly default
    };
  });
}
