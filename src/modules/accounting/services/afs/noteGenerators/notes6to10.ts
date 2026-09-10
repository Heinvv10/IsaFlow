// src/modules/accounting/services/afs/noteGenerators/notes6to10.ts
// AFS Note Engine — generators for Notes 6–10

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from './noteHelpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { agedBucketTable, getAgedBucketTotals } from '@/modules/accounting/services/reports/agedBucketTotals';

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
  const { end } = await getFiscalRange(companyId, fiscalYear);

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
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('Generating note 9 — inventories', { companyId, fiscalYear }, 'noteGenerators');

  // Query GL accounts classified as inventory
  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           COALESCE(SUM(gjl.debit - gjl.credit), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('inventory', 'raw_materials', 'work_in_progress', 'finished_goods', 'consumables')
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    HAVING COALESCE(SUM(gjl.debit - gjl.credit), 0) <> 0
    ORDER BY ga.account_subtype, ga.account_name
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { inventory: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Inventories',
        blocks: [
          {
            type: 'paragraph',
            text: 'No inventories have been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const total = rows.reduce((acc, r) => acc + toNum(r.balance), 0);
  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? '').replace(/_/g, ' '),
    fmt(toNum(r.balance)),
  ]);
  tableRows.push(['Total', '', fmt(total)]);

  const content: NoteContent = {
    title: 'Inventories',
    blocks: [
      {
        type: 'paragraph',
        text: 'Inventories are measured at the lower of cost and estimated selling price less costs to complete and sell. Cost is determined using the weighted average cost method.',
      },
      {
        type: 'table',
        headers: ['Description', 'Category', 'Carrying Value (R)'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot: { inventory: rows }, content };
}

// ── Note 10 — Trade and Other Receivables ─────────────────────────────────────

export async function generateNote10TradeReceivables(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('Generating note 10 — trade receivables', { companyId, fiscalYear }, 'noteGenerators');

  // The aged report at the year end, summed (R-059) — see reports/agedBucketTotals.
  // This used to be its own query over SUM(total_amount) with 'paid' excluded:
  // no settlement netted at all, a document settled after the year end dropped,
  // and drafts counted.
  const aged = await getAgedBucketTotals(companyId, 'ar', end);

  const summaryTable = {
    type: 'table' as const,
    headers: ['', 'Amount (R)'],
    rows: [
      ['Gross trade receivables', fmt(aged.gross)],
      ['Less: Provision for doubtful debts', fmt(0)],
      ['Net trade receivables', fmt(aged.gross)],
    ],
  };

  const agingTable = { type: 'table' as const, ...agedBucketTable(aged, fmt) };

  const content: NoteContent = {
    title: 'Trade and Other Receivables',
    blocks: [summaryTable, agingTable],
  };

  return { dataSnapshot: { receivables: [{ gross_receivables: aged.gross, ...aged }] }, content };
}
