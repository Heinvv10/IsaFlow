// src/modules/accounting/services/afs/noteGenerators/notes21to25.ts
// AFS Note Engine — generators for Notes 21–25

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';
import { fmt, toNum } from './noteHelpers';
import { getCompanyTerminology } from '../entityTerminology';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

// ── Note 21 — Finance Costs ───────────────────────────────────────────────────

export async function generateNote21FinanceCosts(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note21: querying finance costs', { companyId, fiscalYear }, 'noteGenerators');

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(gjl.debit - gjl.credit) AS amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_subtype IN ('interest_expense', 'finance_cost', 'bank_charges')
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.debit - gjl.credit) > 0
    ORDER BY ga.account_subtype
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { financeCosts: [], suppressReason: 'zero_balance' },
      content: { title: 'Finance Costs', blocks: [] },
    };
  }

  const total = rows.reduce((sum, r) => sum + toNum(r.amount), 0);
  const dataRows = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(toNum(r.amount)),
  ]);
  dataRows.push(['Total', '', fmt(total)]);

  return {
    dataSnapshot: { financeCosts: rows },
    content: {
      title: 'Finance Costs',
      blocks: [
        {
          type: 'table',
          headers: ['Description', 'Type', 'Amount'],
          rows: dataRows,
        },
      ],
    },
  };
}

// ── Note 22 — Employee Benefits ───────────────────────────────────────────────

export async function generateNote22EmployeeBenefits(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note22: querying employee benefits', { companyId, fiscalYear }, 'noteGenerators');

  const rows = (await sql`
    SELECT ga.account_subtype,
           SUM(gjl.debit - gjl.credit) AS amount
    FROM gl_journal_lines gjl
    JOIN gl_accounts ga ON ga.id = gjl.gl_account_id
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gjl.company_id = ${companyId}
      AND ga.account_subtype IN ('salaries', 'wages', 'uif', 'medical_aid',
                                 'provident_fund', 'leave_pay', 'bonuses')
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    GROUP BY ga.account_subtype
    ORDER BY ga.account_subtype
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { employeeBenefits: [], suppressReason: 'zero_balance' },
      content: { title: 'Employee Benefits', blocks: [] },
    };
  }

  const total = rows.reduce((sum, r) => sum + toNum(r.amount), 0);
  const dataRows = rows.map((r) => [
    String(r.account_subtype ?? ''),
    fmt(toNum(r.amount)),
  ]);
  dataRows.push(['Total', fmt(total)]);

  return {
    dataSnapshot: { employeeBenefits: rows },
    content: {
      title: 'Employee Benefits',
      blocks: [
        {
          type: 'table',
          headers: ['Benefit Type', 'Amount'],
          rows: dataRows,
        },
      ],
    },
  };
}

// ── Note 23 — Related Party Disclosures ──────────────────────────────────────

export async function generateNote23RelatedParties(
  companyId: string,
  _fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const terms = await getCompanyTerminology(companyId);
  const dataSnapshot = { parties: [] as unknown[], suppressReason: 'table_not_implemented', entityType: terms.entityType };
  const content: NoteContent = {
    title: 'Related Party Disclosures',
    blocks: [
      {
        type: 'paragraph',
        text: 'Related party relationships have not been configured in the system.',
      },
      {
        type: 'paragraph',
        text: `[Accountant: disclose all transactions with ${terms.leadership}, ${terms.owners}, subsidiaries, and entities under common control]`,
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 24 — Auditor's Remuneration ─────────────────────────────────────────

export async function generateNote24AuditorRemuneration(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note24: querying audit fees', { companyId, fiscalYear }, 'noteGenerators');

  const rows = (await sql`
    SELECT ga.account_name,
           SUM(gjl.debit - gjl.credit) AS amount
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id
      AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype = 'audit_fees'
    GROUP BY ga.account_name
  `) as DbRow[];

  if (rows.length > 0) {
    const dataRows = rows.map((r) => [
      String(r.account_name ?? ''),
      fmt(toNum(r.amount)),
    ]);
    return {
      dataSnapshot: { auditFees: rows },
      content: {
        title: "Auditor's Remuneration",
        blocks: [
          {
            type: 'table',
            headers: ['Description', 'Amount'],
            rows: dataRows,
          },
        ],
      },
    };
  }

  return {
    dataSnapshot: { auditFees: [] },
    content: {
      title: "Auditor's Remuneration",
      blocks: [
        {
          type: 'paragraph',
          text: "No audit fee accounts were found in the chart of accounts. [Accountant: enter the auditor's remuneration amount manually]",
        },
      ],
    },
  };
}

// ── Note 25 — Contingencies and Commitments ──────────────────────────────────

export async function generateNote25ContingenciesAndCommitments(
  _companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const dataSnapshot = {};
  const content: NoteContent = {
    title: 'Contingencies and Commitments',
    blocks: [
      {
        type: 'paragraph',
        text: `No contingent liabilities or capital commitments existed at 31 December ${fiscalYear}. [Accountant: update this note if any contingencies or commitments exist]`,
      },
    ],
  };
  return { dataSnapshot, content };
}
