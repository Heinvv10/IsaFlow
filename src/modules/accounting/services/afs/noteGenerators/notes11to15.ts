// src/modules/accounting/services/afs/noteGenerators/notes11to15.ts
// AFS Note Engine — generators for Notes 11–15

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from './noteHelpers';
import { getCompanyTerminology } from '../entityTerminology';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

type DbRow = Record<string, unknown>;

// ── Note 11 — Cash and Cash Equivalents ──────────────────────────────────────

export async function generateNote11CashAndCashEquivalents(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = await getFiscalRange(companyId, fiscalYear);
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
      -- CASH_SUBTYPES, not the literal triple: this note prints in the same
      -- AFS export as the cash KPI tiles, which resolve cash the same way.
      -- The literal missed bank_account and cash_on_hand, so the note and the
      -- tile above it could disagree. account_type is half of that same
      -- resolution: afsKpiCash counts only assets, so without this guard a
      -- liability carrying a bank subtype is cash to the note and not to the
      -- tile printed above it.
      AND ga.account_type = 'asset'
      AND ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
    GROUP BY ga.account_name, ga.account_code
    ORDER BY ga.account_code
  `) as DbRow[];

  const dataSnapshot: Record<string, unknown> = { cashAccounts: rows };

  const dataRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    fmt(toNum(r.balance)),
  ]);

  const total = rows.reduce((acc, r) => acc + toNum(r.balance), 0);
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
  const { end } = await getFiscalRange(companyId, fiscalYear);
  log.info('generateNote12ShareCapital', { companyId, fiscalYear }, 'AfsNote');

  const [rows, terms] = await Promise.all([
    sql`
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
    ` as Promise<DbRow[]>,
    getCompanyTerminology(companyId),
  ]);

  const dataSnapshot: Record<string, unknown> = { shareCapital: rows, entityType: terms.entityType };

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_code ?? ''),
    String(r.account_subtype ?? ''),
    fmt(toNum(r.balance)),
  ]);

  // Entity-aware title and description
  const title = terms.hasShareCapital
    ? 'Share Capital and Reserves'
    : terms.equitySectionTitle;

  const description = terms.hasShareCapital
    ? 'The authorised share capital consists of ordinary shares. All issued shares are fully paid up. [Accountant: confirm authorised share capital details and any changes during the year.]'
    : terms.entityType === 'cc'
      ? `The ${terms.owners}' interest comprises contributions made by ${terms.owners} and accumulated profits. [Accountant: confirm ${terms.owners}' contribution details and any changes during the year.]`
      : `Trust capital comprises the initial contribution and accumulated funds. [Accountant: confirm trust capital details and any movements during the year.]`;

  const content: NoteContent = {
    title,
    blocks: [
      { type: 'paragraph', text: description },
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
  const { end } = await getFiscalRange(companyId, fiscalYear);
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
    fmt(toNum(r.balance)),
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
  const { end } = await getFiscalRange(companyId, fiscalYear);
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
    fmt(toNum(r.balance)),
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
