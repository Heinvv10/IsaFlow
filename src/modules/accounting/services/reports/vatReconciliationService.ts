// src/modules/accounting/services/reports/vatReconciliationService.ts
// VAT Reconciliation — compares GL turnover, VAT returns, and invoice-based VAT
// Provides monthly breakdown, capital vs other goods split, and variance analysis

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type DbRow = Record<string, unknown>;

// ── Types ───────────────────────────────────────────────────────────────────

export interface VatReconMonth {
  month: string;                // YYYY-MM
  // GL-based
  glRevenue: number;            // Total revenue from GL (account_type = 'revenue')
  glOutputVat: number;          // VAT Output balance from GL journals
  glInputVat: number;           // VAT Input balance from GL journals
  glNetVat: number;             // Output - Input
  // Invoice-based
  invoiceRevenue: number;       // Customer invoice totals
  invoiceOutputVat: number;     // Customer invoice VAT
  invoiceInputVat: number;      // Supplier invoice VAT
  // Submitted returns
  returnOutputVat: number | null; // From vat_returns (null = not submitted)
  returnInputVat: number | null;
  returnNetVat: number | null;
  returnStatus: string | null;  // 'submitted' | 'draft' | null
  // Capital goods split
  capitalGoodsOutput: number;
  capitalGoodsInput: number;
  otherGoodsOutput: number;
  otherGoodsInput: number;
  // Variances
  revenueVariance: number;      // GL revenue - Invoice revenue
  outputVatVariance: number;    // GL output VAT - Return output VAT
  inputVatVariance: number;     // GL input VAT - Return input VAT
  effectiveVatRate: number;     // GL output VAT / GL revenue (should be ~15%)
}

export interface VatReconciliation {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  months: VatReconMonth[];
  totals: {
    glRevenue: number;
    glOutputVat: number;
    glInputVat: number;
    glNetVat: number;
    invoiceRevenue: number;
    returnNetVat: number;
    capitalGoodsOutput: number;
    capitalGoodsInput: number;
    revenueVariance: number;
    outputVatVariance: number;
    inputVatVariance: number;
  };
  issues: VatReconIssue[];
}

export interface VatReconIssue {
  month: string;
  severity: 'warning' | 'error';
  message: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

export async function getVatReconciliation(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatReconciliation> {
  log.info('vatReconciliationService: generating reconciliation', { companyId, periodStart, periodEnd });

  // Run all queries in parallel
  const [glMonthly, invoiceMonthly, returnMonthly, capitalSplit] = await Promise.all([
    // 1. GL-based monthly revenue and VAT
    sql`
      SELECT
        TO_CHAR(gje.entry_date, 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue'
          THEN ABS(gjl.credit - gjl.debit) ELSE 0 END), 0) AS gl_revenue,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_output'
          THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS gl_output_vat,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'vat_input'
          THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS gl_input_vat
      FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      WHERE gjl.company_id = ${companyId}
        AND gje.status = 'posted'
        AND gje.entry_date >= ${periodStart}::DATE
        AND gje.entry_date <= ${periodEnd}::DATE
        -- V-05: vatSubmissionService's clearing journal moves the whole period's
        -- output and input tax back off these two control accounts, so without
        -- this the monthly GL net came out SIGN-INVERTED (demo company 2026-02:
        -- -R82,870.39 against a true +R42,549.38) and the report compared a
        -- contaminated GL side against correct invoice and vat_returns figures.
        -- Dating the journal outside the period is not enough: it then lands in
        -- the FOLLOWING month instead. IS DISTINCT FROM, not <>: source is
        -- nullable and an inequality against NULL yields NULL, dropping every
        -- NULL-source journal. Narrow by construction — 'auto_vat_adjustment' is
        -- a separate value in gl_journal_entries_source_check, so manual and
        -- automated VAT adjustments are still counted. Full rationale at the
        -- same predicate in vatReturnService. The revenue arm of this query is
        -- unaffected: the clearing journal posts no revenue line.
        AND gje.source IS DISTINCT FROM 'auto_vat_submission'
        AND (ga.account_type = 'revenue' OR ga.account_subtype IN ('vat_output', 'vat_input'))
      GROUP BY TO_CHAR(gje.entry_date, 'YYYY-MM')
      ORDER BY month
    ` as Promise<DbRow[]>,

    // 2. Invoice-based monthly revenue and VAT
    sql`
      SELECT
        TO_CHAR(ci.invoice_date, 'YYYY-MM') AS month,
        COALESCE(SUM(ci.subtotal), 0) AS invoice_revenue,
        COALESCE(SUM(ci.tax_amount), 0) AS invoice_output_vat
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}
        AND ci.status NOT IN ('cancelled', 'void')
        AND ci.invoice_date >= ${periodStart}::DATE
        AND ci.invoice_date <= ${periodEnd}::DATE
      GROUP BY TO_CHAR(ci.invoice_date, 'YYYY-MM')
      ORDER BY month
    ` as Promise<DbRow[]>,

    // 3. Submitted VAT returns
    sql`
      SELECT
        TO_CHAR(vr.period_start, 'YYYY-MM') AS month,
        vr.total_output_tax AS return_output_vat,
        vr.total_input_tax AS return_input_vat,
        vr.net_vat AS return_net_vat,
        vr.status AS return_status
      FROM vat_returns vr
      WHERE vr.company_id = ${companyId}
        AND vr.period_start >= ${periodStart}::DATE
        AND vr.period_end <= ${periodEnd}::DATE
      ORDER BY month
    ` as Promise<DbRow[]>,

    // 4. Capital goods vs other goods split by month
    sql`
      SELECT
        TO_CHAR(gje.entry_date, 'YYYY-MM') AS month,
        COALESCE(SUM(CASE
          WHEN gjl.vat_type = 'capital_goods' AND ga.account_subtype = 'vat_output'
          THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS capital_output,
        COALESCE(SUM(CASE
          WHEN gjl.vat_type = 'capital_goods' AND ga.account_subtype = 'vat_input'
          THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS capital_input,
        COALESCE(SUM(CASE
          WHEN gjl.vat_type <> 'capital_goods' AND ga.account_subtype = 'vat_output'
          THEN gjl.credit - gjl.debit ELSE 0 END), 0) AS other_output,
        COALESCE(SUM(CASE
          WHEN gjl.vat_type <> 'capital_goods' AND ga.account_subtype = 'vat_input'
          THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS other_input
      FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      WHERE gjl.company_id = ${companyId}
        AND gje.status = 'posted'
        AND gje.entry_date >= ${periodStart}::DATE
        AND gje.entry_date <= ${periodEnd}::DATE
        -- V-05, same predicate as query 1. This split keys off vat_type and the
        -- clearing journal ships vat_type NULL, which both arms of the CASE
        -- happen to drop — so today it is excluded BY LUCK, not by rule.
        -- Excluding by SOURCE keeps it excluded if the clearing entry ever
        -- starts stamping vat_type.
        AND gje.source IS DISTINCT FROM 'auto_vat_submission'
        AND ga.account_subtype IN ('vat_output', 'vat_input')
      GROUP BY TO_CHAR(gje.entry_date, 'YYYY-MM')
      ORDER BY month
    ` as Promise<DbRow[]>,
  ]);

  // Index results by month for fast lookup
  const glMap = new Map(glMonthly.map((r) => [String(r.month), r]));
  const invMap = new Map(invoiceMonthly.map((r) => [String(r.month), r]));
  const retMap = new Map(returnMonthly.map((r) => [String(r.month), r]));
  const capMap = new Map(capitalSplit.map((r) => [String(r.month), r]));

  // Build unique sorted month list
  const allMonths = new Set<string>();
  for (const r of glMonthly) allMonths.add(String(r.month));
  for (const r of invoiceMonthly) allMonths.add(String(r.month));
  for (const r of returnMonthly) allMonths.add(String(r.month));
  const sortedMonths = [...allMonths].sort();

  const issues: VatReconIssue[] = [];
  const months: VatReconMonth[] = sortedMonths.map((month) => {
    const gl = glMap.get(month);
    const inv = invMap.get(month);
    const ret = retMap.get(month);
    const cap = capMap.get(month);

    const glRevenue = toNum(gl?.gl_revenue);
    const glOutputVat = toNum(gl?.gl_output_vat);
    const glInputVat = toNum(gl?.gl_input_vat);
    const glNetVat = r2(glOutputVat - glInputVat);

    const invoiceRevenue = toNum(inv?.invoice_revenue);
    const invoiceOutputVat = toNum(inv?.invoice_output_vat);
    const invoiceInputVat = 0; // Supplier invoices tracked separately

    const returnOutputVat = ret ? toNum(ret.return_output_vat) : null;
    const returnInputVat = ret ? toNum(ret.return_input_vat) : null;
    const returnNetVat = ret ? toNum(ret.return_net_vat) : null;
    const returnStatus = ret ? String(ret.return_status ?? '') : null;

    const capitalGoodsOutput = toNum(cap?.capital_output);
    const capitalGoodsInput = toNum(cap?.capital_input);
    const otherGoodsOutput = toNum(cap?.other_output);
    const otherGoodsInput = toNum(cap?.other_input);

    const revenueVariance = r2(glRevenue - invoiceRevenue);
    const outputVatVariance = returnOutputVat !== null ? r2(glOutputVat - returnOutputVat) : 0;
    const inputVatVariance = returnInputVat !== null ? r2(glInputVat - returnInputVat) : 0;
    const effectiveVatRate = glRevenue > 0 ? r2((glOutputVat / glRevenue) * 100) : 0;

    // Flag issues
    if (Math.abs(revenueVariance) > 100) {
      issues.push({
        month,
        severity: Math.abs(revenueVariance) > 1000 ? 'error' : 'warning',
        message: `Revenue variance of R${fmtNum(revenueVariance)} between GL (R${fmtNum(glRevenue)}) and invoices (R${fmtNum(invoiceRevenue)})`,
      });
    }

    if (returnOutputVat !== null && Math.abs(outputVatVariance) > 50) {
      issues.push({
        month,
        severity: Math.abs(outputVatVariance) > 500 ? 'error' : 'warning',
        message: `Output VAT variance of R${fmtNum(outputVatVariance)} between GL and submitted return`,
      });
    }

    if (effectiveVatRate > 0 && (effectiveVatRate < 14 || effectiveVatRate > 16)) {
      issues.push({
        month,
        severity: effectiveVatRate < 13 || effectiveVatRate > 17 ? 'error' : 'warning',
        message: `Effective VAT rate of ${effectiveVatRate}% outside expected range for 15% standard rate — possible misclassification of exempt/zero-rated supplies`,
      });
    }

    if (!ret) {
      issues.push({
        month,
        severity: 'warning',
        message: 'VAT return not yet submitted for this period',
      });
    }

    return {
      month,
      glRevenue, glOutputVat, glInputVat, glNetVat,
      invoiceRevenue, invoiceOutputVat, invoiceInputVat,
      returnOutputVat, returnInputVat, returnNetVat, returnStatus,
      capitalGoodsOutput, capitalGoodsInput, otherGoodsOutput, otherGoodsInput,
      revenueVariance, outputVatVariance, inputVatVariance, effectiveVatRate,
    };
  });

  // Calculate totals
  const totals = months.reduce(
    (acc, m) => {
      acc.glRevenue += m.glRevenue;
      acc.glOutputVat += m.glOutputVat;
      acc.glInputVat += m.glInputVat;
      acc.glNetVat += m.glNetVat;
      acc.invoiceRevenue += m.invoiceRevenue;
      acc.returnNetVat += m.returnNetVat ?? 0;
      acc.capitalGoodsOutput += m.capitalGoodsOutput;
      acc.capitalGoodsInput += m.capitalGoodsInput;
      acc.revenueVariance += m.revenueVariance;
      acc.outputVatVariance += m.outputVatVariance;
      acc.inputVatVariance += m.inputVatVariance;
      return acc;
    },
    {
      glRevenue: 0, glOutputVat: 0, glInputVat: 0, glNetVat: 0,
      invoiceRevenue: 0, returnNetVat: 0, capitalGoodsOutput: 0, capitalGoodsInput: 0,
      revenueVariance: 0, outputVatVariance: 0, inputVatVariance: 0,
    },
  );

  // Round totals
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    totals[key] = r2(totals[key]);
  }

  return { companyId, periodStart, periodEnd, months, totals, issues };
}

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
        COALESCE(SUM(CASE WHEN ga.account_type = 'revenue'
          THEN ABS(gjl.credit - gjl.debit) ELSE 0 END), 0) AS revenue,
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
        AND gje.source IS DISTINCT FROM 'auto_vat_submission'
        AND (ga.account_type = 'revenue' OR ga.account_subtype IN ('vat_output', 'vat_input'))
      GROUP BY EXTRACT(YEAR FROM gje.entry_date)
      ORDER BY year
    ` as Promise<DbRow[]>,
    sql`
      SELECT
        EXTRACT(YEAR FROM vr.period_start)::INT AS year,
        COUNT(*)::INT AS returns_submitted
      FROM vat_returns vr
      WHERE vr.company_id = ${companyId}
        AND EXTRACT(YEAR FROM vr.period_start) >= ${startYear}
        AND vr.status = 'submitted'
      GROUP BY EXTRACT(YEAR FROM vr.period_start)
      ORDER BY year
    ` as Promise<DbRow[]>,
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
}
