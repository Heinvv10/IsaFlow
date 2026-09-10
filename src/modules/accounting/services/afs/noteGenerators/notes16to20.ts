// src/modules/accounting/services/afs/noteGenerators/notes16to20.ts
// AFS Note Engine — generators for Notes 16–20

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from './noteHelpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import {
  NON_OPERATING_EXPENSE_SUBTYPES,
  OTHER_INCOME_SUBTYPES,
  TAX_EXPENSE_SUBTYPES,
} from '@/modules/accounting/services/gl/accountClassification';

/**
 * Note 17 splits income tax into current and deferred. Both spellings
 * canonicalise to `tax_expense`, so the split is a RAW one inside a single
 * token — the only place in this file a raw spelling is the right comparison.
 */
const DEFERRED_TAX_SUBTYPE = 'deferred_tax_expense';
const CURRENT_TAX_SUBTYPES = TAX_EXPENSE_SUBTYPES.filter((s) => s !== DEFERRED_TAX_SUBTYPE);
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

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
      -- K-053: dated to the figure's own as-at date, so a soft-deleted
      -- document leaves this note exactly when its GL reversal does.
      -- See shared/softDeleteLedgerPresence.
      AND ${documentInLedgerAsAtFragment('si', end, companyId)}
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
        SUM(gjl.debit - gjl.credit) FILTER (
          WHERE ga.account_type = 'expense'
            AND ga.account_subtype = ANY(${CURRENT_TAX_SUBTYPES as string[]}::TEXT[])
        ) AS current_tax,
        SUM(gjl.debit - gjl.credit) FILTER (
          WHERE ga.account_type = 'expense' AND ga.account_subtype = ${DEFERRED_TAX_SUBTYPE}
        ) AS deferred_tax
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
           -- NET movement, not the sum of per-line magnitudes. ABS applied
           -- INSIDE the SUM is applied to each journal line, so a credit note
           -- or sales return debited back to a revenue account was ADDED to
           -- revenue instead of subtracted: R100,000 of sales less an R8,000
           -- credit note printed R108,000 here while the income statement in
           -- the same pack reported R92,000 - overstated by twice the return.
           SUM(gjl.credit - gjl.debit) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_type = 'revenue'
      -- Turnover only. Other income belongs to note 19, and without this the
      -- same account printed in both notes. COALESCE because <> ALL is NULL
      -- for a NULL subtype, which would drop every unclassified revenue
      -- account out of the note - and revenueBand calls those turnover.
      AND COALESCE(ga.account_subtype, '') <> ALL(
        ${OTHER_INCOME_SUBTYPES as string[]}::TEXT[]
      )
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    -- Per ACCOUNT and thresholded exactly as incomeStatementService bands the
    -- same lines: two accounts sharing a name are two rows, and a nil net
    -- movement is dropped in either direction.
    GROUP BY ga.id, ga.account_name, ga.account_code, ga.account_subtype
    HAVING ABS(SUM(gjl.credit - gjl.debit)) > 0.001
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
           -- Same per-line ABS defect as note 18: a reversed accrual debited
           -- back to an other-income account was ADDED, so R3,000 credited
           -- less a R1,000 reversal printed R4,000 against the income
           -- statement's R2,000.
           SUM(gjl.credit - gjl.debit) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      -- The band revenueBand calls other income, and nothing else. The four
      -- hand-written spellings this list used to add are absent from the
      -- canonical vocabulary, so the income statement reports them as
      -- turnover; claiming them here made notes 18 and 19 overlap instead of
      -- partition. See OTHER_INCOME_SUBTYPES.
      AND ga.account_subtype = ANY(${OTHER_INCOME_SUBTYPES as string[]}::TEXT[])
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    GROUP BY ga.id, ga.account_name, ga.account_subtype
    HAVING ABS(SUM(gjl.credit - gjl.debit)) > 0.001
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
      -- COALESCE: NOT IN is NULL for a NULL subtype, which dropped every
      -- unclassified expense out of the note. The excluded set is derived from
      -- the SAME bands expenseBand reads, so this note prints exactly what
      -- the income statement in the same pack calls an operating expense. A
      -- hand-list here named income tax by two spellings of its own and other
      -- expenses by none, so five spellings were reported below the operating
      -- line by the income statement and inside this note simultaneously.
      AND COALESCE(ga.account_subtype, '') <> ALL(
        ${NON_OPERATING_EXPENSE_SUBTYPES as string[]}::TEXT[]
      )
      AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
    -- Grouped and thresholded EXACTLY as incomeStatementService bands the same
    -- lines: per ACCOUNT, keeping any non-nil movement in either direction.
    -- A one-sided HAVING dropped every net-credit operating expense - a
    -- supplier rebate, a credit note raised against an expense, a reversed
    -- over-accrual - so the note overstated the operating-expense line by the
    -- whole credit balance while still footing to its own visible rows.
    -- Grouping by name alone netted two distinct accounts that happen to share
    -- a name into one row, or out of the note entirely when they cancelled.
    GROUP BY ga.id, ga.account_name, ga.account_subtype
    HAVING ABS(SUM(gjl.debit - gjl.credit)) > 0.001
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
