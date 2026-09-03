// src/modules/accounting/services/afs/noteGenerators/notes16to20.ts
// AFS Note Engine — generators for Notes 16–20

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from './noteHelpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

type DbRow = Record<string, unknown>;

// ── Note 16 — Trade and Other Payables ───────────────────────────────────────

export async function generateNote16TradePayables(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote16TradePayables', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT
      SUM(si.total_amount) FILTER (WHERE si.status NOT IN ('paid','cancelled','void')) AS gross_payables,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::DATE AND si.due_date > ${end}::DATE - INTERVAL '30 days'
      ) AS current_amount,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::DATE - INTERVAL '30 days'
          AND si.due_date > ${end}::DATE - INTERVAL '60 days'
      ) AS days_30,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::DATE - INTERVAL '60 days'
      ) AS days_60_plus
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId} AND si.invoice_date <= ${end}
  `) as DbRow[];

  const r = rows[0] ?? {};
  const gross = toNum(r.gross_payables);
  const current = toNum(r.current_amount);
  const d30 = toNum(r.days_30);
  const d60plus = toNum(r.days_60_plus);
  const total = current + d30 + d60plus;

  return {
    dataSnapshot: { payables: rows },
    content: {
      title: 'Trade and Other Payables',
      blocks: [
        { type: 'table', headers: ['', 'Amount (R)'],
          rows: [['Trade payables', fmt(gross)], ['Accrued liabilities', fmt(0)], ['Total', fmt(gross)]] },
        { type: 'table', headers: ['Current', '30 days', '60+ days', 'Total'],
          rows: [[fmt(current), fmt(d30), fmt(d60plus), fmt(total)]] },
      ],
    },
  };
}

// ── Note 17 — Income Tax and Deferred Tax ────────────────────────────────────

export async function generateNote17IncomeTax(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote17IncomeTax', { companyId, fiscalYear }, 'AfsNote');

  const [taxProvision, deferredBalance] = await Promise.all([
    sql`SELECT
        SUM(gjl.debit) FILTER (WHERE ga.account_subtype = 'income_tax_expense') AS current_tax,
        SUM(gjl.debit) FILTER (WHERE ga.account_subtype = 'deferred_tax_expense') AS deferred_tax
      FROM gl_journal_lines gjl
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      WHERE gjl.company_id = ${companyId}
        AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'`,
    sql`SELECT
        SUM(gjl.debit - gjl.credit) FILTER (WHERE ga.account_subtype = 'deferred_tax_asset') AS dta,
        SUM(gjl.credit - gjl.debit) FILTER (WHERE ga.account_subtype = 'deferred_tax_liability') AS dtl
      FROM gl_journal_lines gjl
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      WHERE gjl.company_id = ${companyId}
        AND gje.entry_date <= ${end} AND gje.status = 'posted'`,
  ]);

  const tp = (taxProvision as DbRow[])[0] ?? {};
  const db = (deferredBalance as DbRow[])[0] ?? {};
  const currentTax = toNum(tp.current_tax);
  const deferredTax = toNum(tp.deferred_tax);
  const totalTax = currentTax + deferredTax;

  return {
    dataSnapshot: { taxProvision, deferredBalance },
    content: {
      title: 'Income Tax and Deferred Tax',
      blocks: [{
        type: 'table', headers: ['', 'Amount (R)'],
        rows: [
          ['Current tax expense', fmt(currentTax)],
          ['Deferred tax expense/(income)', fmt(deferredTax)],
          ['Total tax expense', fmt(totalTax)],
          ['Deferred tax asset', fmt(toNum(db.dta))],
          ['Deferred tax liability', fmt(toNum(db.dtl))],
        ],
      }],
    },
  };
}

// ── Note 18 — Revenue Disaggregation ─────────────────────────────────────────

export async function generateNote18RevenueDisaggregation(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote18RevenueDisaggregation', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           SUM(ABS(gjl.credit - gjl.debit)) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_type = 'revenue'
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    ORDER BY net_amount DESC
  `) as DbRow[];

  if (rows.length === 0) {
    return { dataSnapshot: { revenue: rows }, content: { title: 'Revenue Disaggregation', blocks: [] } };
  }

  const tableRows = rows.map((r) => [String(r.account_name ?? ''), String(r.account_code ?? ''), fmt(toNum(r.net_amount))]);
  tableRows.push(['Total', '', fmt(rows.reduce((acc, r) => acc + toNum(r.net_amount), 0))]);

  return {
    dataSnapshot: { revenue: rows },
    content: {
      title: 'Revenue Disaggregation',
      blocks: [{ type: 'table', headers: ['Revenue Stream', 'Code', 'Amount'], rows: tableRows }],
    },
  };
}

// ── Note 19 — Other Income and Finance Income ────────────────────────────────

export async function generateNote19OtherIncome(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote19OtherIncome', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(ABS(gjl.credit - gjl.debit)) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_subtype IN (
        'other_income', 'interest_income', 'dividend_income', 'rental_income', 'gain_on_disposal'
      )
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(ABS(gjl.credit - gjl.debit)) > 0
    ORDER BY ga.account_subtype
  `) as DbRow[];

  if (rows.length === 0) {
    return { dataSnapshot: { otherIncome: rows }, content: { title: 'Other Income and Finance Income', blocks: [] } };
  }

  return {
    dataSnapshot: { otherIncome: rows },
    content: {
      title: 'Other Income and Finance Income',
      blocks: [{
        type: 'table', headers: ['Description', 'Type', 'Amount'],
        rows: rows.map((r) => [String(r.account_name ?? ''), String(r.account_subtype ?? ''), fmt(toNum(r.net_amount))]),
      }],
    },
  };
}

// ── Note 20 — Operating Expenses by Nature ───────────────────────────────────

export async function generateNote20OperatingExpenses(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote20OperatingExpenses', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(gjl.debit - gjl.credit) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_type = 'expense'
      AND ga.account_subtype NOT IN (
        'income_tax_expense', 'deferred_tax_expense', 'interest_expense', 'finance_cost'
      )
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.debit - gjl.credit) > 0
    ORDER BY net_amount DESC
  `) as DbRow[];

  if (rows.length === 0) {
    return { dataSnapshot: { operatingExpenses: rows }, content: { title: 'Operating Expenses by Nature', blocks: [] } };
  }

  const tableRows = rows.map((r) => [String(r.account_name ?? ''), String(r.account_subtype ?? ''), fmt(toNum(r.net_amount))]);
  tableRows.push(['Total', '', fmt(rows.reduce((acc, r) => acc + toNum(r.net_amount), 0))]);

  return {
    dataSnapshot: { operatingExpenses: rows },
    content: {
      title: 'Operating Expenses by Nature',
      blocks: [{ type: 'table', headers: ['Expense', 'Category', 'Amount'], rows: tableRows }],
    },
  };
}
