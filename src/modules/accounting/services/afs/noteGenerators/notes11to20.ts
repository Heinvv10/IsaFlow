// src/modules/accounting/services/afs/noteGenerators/notes11to20.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

type DbRow = Record<string, unknown>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fiscalRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// ── Note 11 — Cash and Cash Equivalents ──────────────────────────────────────

export async function generateNote11CashAndCashEquivalents(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);
  log.info('generateNote11CashAndCashEquivalents', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_code,
      COALESCE(SUM(gjl.debit - gjl.credit), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('bank', 'cash', 'petty_cash')
    GROUP BY ga.account_name, ga.account_code
    ORDER BY ga.account_code
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { cashAccounts: rows };

  const dataRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    fmt(r.balance as number | null),
  ]);

  const total = rows.reduce((acc, r) => acc + Number(r.balance ?? 0), 0);
  dataRows.push(['Total', '', fmt(total)]);

  const content: NoteContent = {
    title: 'Cash and Cash Equivalents',
    blocks: [
      {
        type: 'paragraph',
        text: 'Cash and cash equivalents comprise bank balances and petty cash held at year end. The carrying amounts of these balances approximate their fair values.',
      },
      {
        type: 'table',
        headers: ['Bank Account', 'Code', 'Balance (R)'],
        rows: dataRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 12 — Share Capital and Reserves ─────────────────────────────────────

export async function generateNote12ShareCapital(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);
  log.info('generateNote12ShareCapital', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           SUM(gjl.credit - gjl.debit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_type = 'equity'
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    HAVING SUM(gjl.credit - gjl.debit) <> 0
    ORDER BY ga.account_code
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { shareCapital: rows };

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    String(r.account_subtype ?? ''),
    fmt(r.balance as number | null),
  ]);

  const content: NoteContent = {
    title: 'Share Capital and Reserves',
    blocks: [
      {
        type: 'paragraph',
        text: 'The authorised share capital consists of ordinary shares. All issued shares are fully paid up. [Accountant: confirm authorised share capital details and any changes during the year.]',
      },
      {
        type: 'table',
        headers: ['Account', 'Code', 'Subtype', 'Balance'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 13 — Borrowings ─────────────────────────────────────────────────────

export async function generateNote13Borrowings(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);
  log.info('generateNote13Borrowings', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           SUM(gjl.credit - gjl.debit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('bank_loan', 'mortgage', 'overdraft', 'finance_lease', 'shareholder_loan')
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    HAVING SUM(gjl.credit - gjl.debit) <> 0
    ORDER BY ga.account_subtype
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { borrowings: rows };

  if (rows.length === 0) {
    return { dataSnapshot, content: { title: 'Borrowings', blocks: [] } };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    String(r.account_subtype ?? ''),
    fmt(r.balance as number | null),
  ]);

  const content: NoteContent = {
    title: 'Borrowings',
    blocks: [
      {
        type: 'paragraph',
        text: 'Borrowings are initially recognised at fair value, net of transaction costs, and subsequently measured at amortised cost. [Accountant: complete security and covenant details for each facility.]',
      },
      {
        type: 'table',
        headers: ['Facility', 'Code', 'Type', 'Balance'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 14 — Lease Liabilities (table not implemented) ──────────────────────

export async function generateNote14LeaseLiabilities(
  _companyId: string,
  _fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const dataSnapshot: Record<string, unknown> = {
    leases: [] as unknown[],
    suppressReason: 'table_not_implemented',
  };
  const content: NoteContent = {
    title: 'Lease Liabilities (IFRS 16)',
    blocks: [
      {
        type: 'paragraph',
        text: 'Lease liabilities under IFRS 16 have not been configured for this entity. [Accountant: complete this note if any leases exist]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 15 — Provisions ─────────────────────────────────────────────────────

export async function generateNote15Provisions(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);
  log.info('generateNote15Provisions', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(gjl.credit - gjl.debit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('provision', 'warranty_provision', 'leave_pay_provision')
      AND gje.entry_date <= ${end}
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.credit - gjl.debit) > 0
    ORDER BY ga.account_subtype
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { provisions: rows };

  if (rows.length === 0) {
    return { dataSnapshot, content: { title: 'Provisions', blocks: [] } };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(r.balance as number | null),
  ]);

  const content: NoteContent = {
    title: 'Provisions',
    blocks: [
      {
        type: 'table',
        headers: ['Provision', 'Type', 'Balance'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 16 — Trade and Other Payables ───────────────────────────────────────

export async function generateNote16TradePayables(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);
  log.info('generateNote16TradePayables', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
      ) AS gross_payables,
      SUM(si.total_amount) FILTER (
        WHERE si.status NOT IN ('paid','cancelled','void')
          AND si.due_date <= ${end}::DATE
          AND si.due_date > ${end}::DATE - INTERVAL '30 days'
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
    WHERE si.company_id = ${companyId}
      AND si.invoice_date <= ${end}
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { payables: rows };

  const r = rows[0] ?? {};
  const gross = r.gross_payables as number | null;
  const current = r.current_amount as number | null;
  const d30 = r.days_30 as number | null;
  const d60plus = r.days_60_plus as number | null;
  const total = (current ?? 0) + (d30 ?? 0) + (d60plus ?? 0);

  const summaryRows: string[][] = [
    ['Trade payables', fmt(gross)],
    ['Accrued liabilities', fmt(0)],
    ['Total', fmt(gross)],
  ];

  const agingRows: string[][] = [
    [fmt(current), fmt(d30), fmt(d60plus), fmt(total)],
  ];

  const content: NoteContent = {
    title: 'Trade and Other Payables',
    blocks: [
      {
        type: 'table',
        headers: ['', 'Amount (R)'],
        rows: summaryRows,
      },
      {
        type: 'table',
        headers: ['Current', '30 days', '60+ days', 'Total'],
        rows: agingRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 17 — Income Tax and Deferred Tax ────────────────────────────────────

export async function generateNote17IncomeTax(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);
  log.info('generateNote17IncomeTax', { companyId, fiscalYear }, 'AfsNote');

  const [taxProvision, deferredBalance] = await Promise.all([
    sql`
      SELECT
        SUM(gjl.debit) FILTER (WHERE ga.account_subtype = 'income_tax_expense') AS current_tax,
        SUM(gjl.debit) FILTER (WHERE ga.account_subtype = 'deferred_tax_expense') AS deferred_tax
      FROM gl_journal_lines gjl
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      WHERE gjl.company_id = ${companyId}
        AND gje.entry_date BETWEEN ${start} AND ${end}
        AND gje.status = 'posted'
    `,
    sql`
      SELECT
        SUM(gjl.debit - gjl.credit) FILTER (WHERE ga.account_subtype = 'deferred_tax_asset') AS dta,
        SUM(gjl.credit - gjl.debit) FILTER (WHERE ga.account_subtype = 'deferred_tax_liability') AS dtl
      FROM gl_journal_lines gjl
      JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      WHERE gjl.company_id = ${companyId}
        AND gje.entry_date <= ${end}
        AND gje.status = 'posted'
    `,
  ]);

  const tp = (taxProvision as DbRow[])[0] ?? {};
  const db = (deferredBalance as DbRow[])[0] ?? {};

  const dataSnapshot: Record<string, unknown> = { taxProvision, deferredBalance };

  const currentTax = (tp.current_tax as number | null) ?? 0;
  const deferredTax = (tp.deferred_tax as number | null) ?? 0;
  const dta = (db.dta as number | null) ?? 0;
  const dtl = (db.dtl as number | null) ?? 0;
  const totalTax = currentTax + deferredTax;

  const tableRows: string[][] = [
    ['Current tax expense', fmt(currentTax)],
    ['Deferred tax expense/(income)', fmt(deferredTax)],
    ['Total tax expense', fmt(totalTax)],
    ['Deferred tax asset', fmt(dta)],
    ['Deferred tax liability', fmt(dtl)],
  ];

  const content: NoteContent = {
    title: 'Income Tax and Deferred Tax',
    blocks: [
      {
        type: 'table',
        headers: ['', 'Amount (R)'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 18 — Revenue Disaggregation ─────────────────────────────────────────

export async function generateNote18RevenueDisaggregation(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);
  log.info('generateNote18RevenueDisaggregation', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           SUM(ABS(gjl.credit - gjl.debit)) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_type = 'revenue'
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    ORDER BY net_amount DESC
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { revenue: rows };

  if (rows.length === 0) {
    return { dataSnapshot, content: { title: 'Revenue Disaggregation', blocks: [] } };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    fmt(r.net_amount as number | null),
  ]);

  const total = rows.reduce((acc, r) => acc + Number(r.net_amount ?? 0), 0);
  tableRows.push(['Total', '', fmt(total)]);

  const content: NoteContent = {
    title: 'Revenue Disaggregation',
    blocks: [
      {
        type: 'table',
        headers: ['Revenue Stream', 'Code', 'Amount'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 19 — Other Income and Finance Income ────────────────────────────────

export async function generateNote19OtherIncome(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);
  log.info('generateNote19OtherIncome', { companyId, fiscalYear }, 'AfsNote');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(ABS(gjl.credit - gjl.debit)) AS net_amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_subtype IN (
        'other_income', 'interest_income', 'dividend_income',
        'rental_income', 'gain_on_disposal'
      )
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(ABS(gjl.credit - gjl.debit)) > 0
    ORDER BY ga.account_subtype
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { otherIncome: rows };

  if (rows.length === 0) {
    return { dataSnapshot, content: { title: 'Other Income and Finance Income', blocks: [] } };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(r.net_amount as number | null),
  ]);

  const content: NoteContent = {
    title: 'Other Income and Finance Income',
    blocks: [
      {
        type: 'table',
        headers: ['Description', 'Type', 'Amount'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}

// ── Note 20 — Operating Expenses by Nature ───────────────────────────────────

export async function generateNote20OperatingExpenses(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);
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
        'income_tax_expense', 'deferred_tax_expense',
        'interest_expense', 'finance_cost'
      )
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.debit - gjl.credit) > 0
    ORDER BY net_amount DESC
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { operatingExpenses: rows };

  if (rows.length === 0) {
    return { dataSnapshot, content: { title: 'Operating Expenses by Nature', blocks: [] } };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(r.net_amount as number | null),
  ]);

  const total = rows.reduce((acc, r) => acc + Number(r.net_amount ?? 0), 0);
  tableRows.push(['Total', '', fmt(total)]);

  const content: NoteContent = {
    title: 'Operating Expenses by Nature',
    blocks: [
      {
        type: 'table',
        headers: ['Expense', 'Category', 'Amount'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot, content };
}
