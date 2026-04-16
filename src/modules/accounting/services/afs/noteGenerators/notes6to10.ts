// src/modules/accounting/services/afs/noteGenerators/notes6to10.ts
// AFS Note Engine — generators for Notes 6–10

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

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

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

type NoteResult = { dataSnapshot: Record<string, unknown>; content: NoteContent };

// ── Note 6 — Investment Property ──────────────────────────────────────────────

export async function generateNote6InvestmentProperty(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { investmentProperty: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Investment Property',
    blocks: [
      {
        type: 'paragraph',
        text: 'No investment property has been recorded. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 7 — Investments in Associates ───────────────────────────────────────

export async function generateNote7InvestmentsInAssociates(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { associates: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Investments in Associates',
    blocks: [
      {
        type: 'paragraph',
        text: 'No investments in associates have been recorded. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 8 — Financial Assets ─────────────────────────────────────────────────

export async function generateNote8FinancialAssets(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = fiscalRange(fiscalYear);

  log.info('Generating note 8 — tax expense', { companyId, fiscalYear }, 'noteGenerators');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(gjl.debit - gjl.credit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id
      AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('investment', 'financial_asset', 'loan_receivable')
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.debit - gjl.credit) <> 0
    ORDER BY ga.account_subtype, ga.account_name
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { financialAssets: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Financial Assets',
        blocks: [
          {
            type: 'paragraph',
            text: 'No financial assets have been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(toNum(r.balance)),
  ]);

  const content: NoteContent = {
    title: 'Financial Assets',
    blocks: [
      {
        type: 'table',
        headers: ['Account', 'Classification', 'Balance'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot: { financialAssets: rows }, content };
}

// ── Note 9 — Inventories ──────────────────────────────────────────────────────

export async function generateNote9Inventories(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { inventory: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Inventories',
    blocks: [
      {
        type: 'paragraph',
        text: 'Inventory items have not been configured in the system. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 10 — Trade and Other Receivables ─────────────────────────────────────

export async function generateNote10TradeReceivables(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = fiscalRange(fiscalYear);

  log.info('Generating note 10 — trade receivables', { companyId, fiscalYear }, 'noteGenerators');

  const rows = (await sql`
    SELECT
      SUM(ci.total_amount) FILTER (WHERE ci.status NOT IN ('paid','cancelled','void')) AS gross_receivables,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE AND ci.due_date > ${end}::DATE - INTERVAL '30 days'
      ) AS current_amount,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '30 days'
          AND ci.due_date > ${end}::DATE - INTERVAL '60 days'
      ) AS days_30,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '60 days'
          AND ci.due_date > ${end}::DATE - INTERVAL '90 days'
      ) AS days_60,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '90 days'
      ) AS days_90_plus
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId} AND ci.invoice_date <= ${end}
  `) as DbRow[];

  const row = rows[0] ?? {};
  const gross = toNum(row.gross_receivables);
  const current = toNum(row.current_amount);
  const d30 = toNum(row.days_30);
  const d60 = toNum(row.days_60);
  const d90plus = toNum(row.days_90_plus);
  const agingTotal = current + d30 + d60 + d90plus;

  const summaryTable = {
    type: 'table' as const,
    headers: ['', 'Amount (R)'],
    rows: [
      ['Gross trade receivables', fmt(gross)],
      ['Less: Provision for doubtful debts', fmt(0)],
      ['Net trade receivables', fmt(gross)],
    ],
  };

  const agingTable = {
    type: 'table' as const,
    headers: ['Current', '30 days', '60 days', '90+ days', 'Total'],
    rows: [[fmt(current), fmt(d30), fmt(d60), fmt(d90plus), fmt(agingTotal)]],
  };

  const content: NoteContent = {
    title: 'Trade and Other Receivables',
    blocks: [summaryTable, agingTable],
  };

  return { dataSnapshot: { receivables: rows }, content };
}
