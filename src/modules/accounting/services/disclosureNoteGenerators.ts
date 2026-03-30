/**
 * IFRS Disclosure Note Generators — WS-7.2
 * Each function queries live financial data and returns a formatted DisclosureNote.
 */

import { sql } from '@/lib/neon';
import type { DisclosureNote } from './disclosureNoteService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fiscalRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// ── Note 1: Accounting Policies ───────────────────────────────────────────────

export async function noteAccountingPolicies(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const rows = await sql`
    SELECT depreciation_method, inventory_valuation_method, default_currency, vat_system_type
    FROM companies WHERE id = ${companyId}
  ` as Row[];

  const c = rows[0] ?? {};
  const depMethod = c.depreciation_method ?? 'straight-line';
  const invMethod = c.inventory_valuation_method ?? 'weighted average cost';
  const currency = c.default_currency ?? 'ZAR';
  const vatType = c.vat_system_type ?? 'invoice';

  const content = [
    `Basis of preparation: The annual financial statements have been prepared on the historical cost basis and in accordance with International Financial Reporting Standards (IFRS) and the requirements of the Companies Act of South Africa. The functional and presentation currency is ${currency}.`,
    ``,
    `Property, Plant and Equipment: Stated at cost less accumulated depreciation and impairment losses. Depreciation is calculated on the ${depMethod} method over the estimated useful lives of assets.`,
    ``,
    `Inventories: Valued at the lower of cost and net realisable value. Cost is determined using the ${invMethod} method.`,
    ``,
    `Revenue Recognition: Revenue from the sale of goods is recognised when the significant risks and rewards of ownership have passed to the buyer. Revenue from services is recognised in the period in which the services are rendered.`,
    ``,
    `Taxation: Value Added Tax (VAT) is accounted for on the ${vatType} basis as registered with the South African Revenue Service (SARS).`,
  ].join('\n');

  return { noteNumber: 1, title: 'Accounting Policies', content, source: 'auto' };
}

// ── Note 2: Property, Plant & Equipment ───────────────────────────────────────

export async function notePPE(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT
      fa.category,
      SUM(fa.cost) AS total_cost,
      SUM(fa.accumulated_depreciation) AS total_accum_dep,
      SUM(CASE WHEN fa.acquisition_date BETWEEN ${start} AND ${end} THEN fa.cost ELSE 0 END) AS additions,
      SUM(CASE WHEN fa.disposal_date BETWEEN ${start} AND ${end} THEN fa.cost ELSE 0 END) AS disposals,
      SUM(fa.depreciation_charge) AS dep_charge
    FROM fixed_assets fa
    WHERE fa.company_id = ${companyId}
      AND (fa.disposal_date IS NULL OR fa.disposal_date >= ${start})
    GROUP BY fa.category
    ORDER BY fa.category
  ` as Row[];

  const headers = ['Category', 'Cost', 'Accum Depr', 'Carrying Value', 'Additions', 'Disposals', 'Depr Charge'];
  const tableRows: string[][] = rows.map((r: Row) => {
    const cv = (Number(r.total_cost) || 0) - (Number(r.total_accum_dep) || 0);
    return [r.category ?? 'Uncategorised', fmt(r.total_cost), fmt(r.total_accum_dep), fmt(cv), fmt(r.additions), fmt(r.disposals), fmt(r.dep_charge)];
  });

  const totalCost = rows.reduce((s: number, r: Row) => s + (Number(r.total_cost) || 0), 0);
  const totalAccum = rows.reduce((s: number, r: Row) => s + (Number(r.total_accum_dep) || 0), 0);
  tableRows.push(['Total', fmt(totalCost), fmt(totalAccum), fmt(totalCost - totalAccum), '', '', '']);

  const content = `The table below summarises the movement in property, plant and equipment for the year ended 31 December ${fiscalYear}. Depreciation is charged to profit or loss on a systematic basis over the estimated useful lives of the assets.`;

  return {
    noteNumber: 2,
    title: 'Property, Plant and Equipment',
    content,
    tables: rows.length > 0 ? [{ headers, rows: tableRows }] : undefined,
    source: 'auto',
  };
}

// ── Note 3: Trade & Other Receivables ─────────────────────────────────────────

export async function noteReceivables(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT
      SUM(ci.total_amount) FILTER (WHERE ci.status NOT IN ('paid','cancelled','void')) AS gross_receivables,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::date AND ci.due_date > ${end}::date - INTERVAL '30 days'
      ) AS current_amount,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::date - INTERVAL '30 days'
          AND ci.due_date > ${end}::date - INTERVAL '60 days'
      ) AS days_30,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::date - INTERVAL '60 days'
          AND ci.due_date > ${end}::date - INTERVAL '90 days'
      ) AS days_60,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::date - INTERVAL '90 days'
      ) AS days_90_plus
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId} AND ci.invoice_date <= ${end}
  ` as Row[];

  const r = rows[0] ?? {};
  const gross = Number(r.gross_receivables) || 0;

  return {
    noteNumber: 3,
    title: 'Trade and Other Receivables',
    content: `Trade receivables are carried at original invoice amount less any provision for doubtful debts assessed at the reporting date based on objective evidence of impairment.`,
    tables: [
      { headers: ['', 'Amount (R)'], rows: [['Gross trade receivables', fmt(gross)], ['Less: Provision for doubtful debts', fmt(0)], ['Net trade receivables', fmt(gross)]] },
      { headers: ['Current', '30 days', '60 days', '90+ days', 'Total'], rows: [[fmt(r.current_amount), fmt(r.days_30), fmt(r.days_60), fmt(r.days_90_plus), fmt(gross)]] },
    ],
    source: 'auto',
  };
}

// ── Note 4: Trade & Other Payables ────────────────────────────────────────────

export async function notePayables(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT
      SUM(si.total_amount) FILTER (WHERE si.status NOT IN ('paid','cancelled','void')) AS gross_payables,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::date AND si.due_date > ${end}::date - INTERVAL '30 days'
      ) AS current_amount,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::date - INTERVAL '30 days'
          AND si.due_date > ${end}::date - INTERVAL '60 days'
      ) AS days_30,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::date - INTERVAL '60 days'
      ) AS days_60_plus
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId} AND si.invoice_date <= ${end}
  ` as Row[];

  const r = rows[0] ?? {};
  const gross = Number(r.gross_payables) || 0;

  return {
    noteNumber: 4,
    title: 'Trade and Other Payables',
    content: `Trade and other payables are carried at cost which is the fair value of the consideration to be paid in the future for goods and services received, whether or not billed to the entity.`,
    tables: [
      { headers: ['', 'Amount (R)'], rows: [['Trade payables', fmt(gross)], ['Accrued liabilities', fmt(0)], ['Total trade and other payables', fmt(gross)]] },
      { headers: ['Current', '30 days', '60+ days', 'Total'], rows: [[fmt(r.current_amount), fmt(r.days_30), fmt(r.days_60_plus), fmt(gross)]] },
    ],
    source: 'auto',
  };
}

// ── Note 5: Revenue ───────────────────────────────────────────────────────────

export async function noteRevenue(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT ga.account_name, ga.account_code,
      SUM(ABS(gjl.credit_amount - gjl.debit_amount)) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_type = 'revenue'
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_code
    ORDER BY net_amount DESC
  ` as Row[];

  const total = rows.reduce((s: number, r: Row) => s + (Number(r.net_amount) || 0), 0);
  const tableRows: string[][] = rows.map((r: Row) => [r.account_name, r.account_code, fmt(r.net_amount)]);
  tableRows.push(['Total Revenue', '', fmt(total)]);

  return {
    noteNumber: 5,
    title: 'Revenue',
    content: `Revenue is measured at the fair value of the consideration received or receivable and represents amounts receivable for goods and services provided in the normal course of business, net of discounts and VAT.`,
    tables: tableRows.length > 1 ? [{ headers: ['Account', 'Code', 'Amount (R)'], rows: tableRows }] : undefined,
    source: 'auto',
  };
}

// ── Note 6: Cash and Cash Equivalents ─────────────────────────────────────────

export async function noteCash(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT ga.account_name, ga.account_code,
      COALESCE(SUM(gjl.debit_amount - gjl.credit_amount), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl ON gjl.account_id = ga.id AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('bank', 'cash', 'petty_cash')
    GROUP BY ga.account_name, ga.account_code
    ORDER BY ga.account_code
  ` as Row[];

  const total = rows.reduce((s: number, r: Row) => s + (Number(r.balance) || 0), 0);
  const tableRows: string[][] = rows.map((r: Row) => [r.account_name, r.account_code, fmt(r.balance)]);
  tableRows.push(['Total', '', fmt(total)]);

  return {
    noteNumber: 6,
    title: 'Cash and Cash Equivalents',
    content: `Cash and cash equivalents include cash on hand and deposits held at call with banks. Bank overdrafts are shown within borrowings in current liabilities on the balance sheet.`,
    tables: tableRows.length > 1 ? [{ headers: ['Bank Account', 'Code', 'Balance (R)'], rows: tableRows }] : undefined,
    source: 'auto',
  };
}

// ── Note 7: Taxation (VAT) ────────────────────────────────────────────────────

export async function noteTaxation(companyId: string, fiscalYear: number): Promise<DisclosureNote> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = await sql`
    SELECT
      SUM(gjl.debit_amount) FILTER (WHERE ga.account_subtype = 'vat_input') AS vat_input,
      SUM(gjl.credit_amount) FILTER (WHERE ga.account_subtype = 'vat_output') AS vat_output
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_subtype IN ('vat_input', 'vat_output')
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
  ` as Row[];

  const r = rows[0] ?? {};
  const input = Number(r.vat_input) || 0;
  const output = Number(r.vat_output) || 0;

  return {
    noteNumber: 7,
    title: 'Taxation',
    content: `The company is registered for Value Added Tax (VAT) with SARS. VAT is levied at the standard rate of 15% on all taxable supplies. The reconciliation below reflects the net VAT position for the year ended 31 December ${fiscalYear}.`,
    tables: [{
      headers: ['', 'Amount (R)'],
      rows: [
        ['Output VAT (collected from customers)', fmt(output)],
        ['Input VAT (paid to suppliers)', fmt(input)],
        ['Net VAT payable / (receivable)', fmt(output - input)],
      ],
    }],
    source: 'auto',
  };
}
