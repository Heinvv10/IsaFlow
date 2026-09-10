// src/modules/accounting/services/afs/noteGenerators/notes26to30.ts
// AFS Note Engine — generators for Notes 26–30

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';
import { fmt, toNum } from './noteHelpers';
import { getCompanyTerminology } from '../entityTerminology';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import {
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
} from '@/modules/accounting/services/gl/accountSubtypes';
import { fetchBalanceSnapshot } from '@/modules/accounting/services/afs/afsKpiService';

// ── Note 26 — Events After Reporting Date ────────────────────────────────────

export async function generateNote26EventsAfterReportingDate(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note26: querying post-period journal entries', { companyId, fiscalYear });

  const rows = (await sql`
    SELECT gje.description, gje.entry_date, gje.total_amount
    FROM gl_journal_entries gje
    WHERE gje.company_id = ${companyId}
      AND gje.entry_date > ${end}
      AND gje.entry_date <= NOW()
      AND gje.status = 'posted'
    ORDER BY gje.entry_date DESC
    LIMIT 20
  `) as DbRow[];

  const blocks: NoteContent['blocks'] = [];

  if (rows.length > 0) {
    const items = rows.map((r) => {
      const dateStr = fmtDate(r.entry_date);
      return `${dateStr} — ${String(r.description ?? '')} (${fmt(toNum(r.total_amount))})`;
    });
    blocks.push({ type: 'list', items });
  }

  blocks.push({
    type: 'paragraph',
    text: '[Accountant: review and describe any adjusting or non-adjusting events after the reporting date]',
  });

  return {
    dataSnapshot: { postPeriodEntries: rows },
    content: { title: 'Events After Reporting Date', blocks },
  };
}

// ── Note 27 — Going Concern ──────────────────────────────────────────────────

export async function generateNote27GoingConcern(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note27: querying going concern indicators', { companyId, fiscalYear });

  const [balance, profitRows, terms] = await Promise.all([
    // The SAME current/non-current split the KPI scorecard reads, not a
    // whitelist of its own. This note carried a three-token list — cash,
    // receivables, inventory — while `afsKpiService` counts everything that is
    // not `NON_CURRENT_SUBTYPES`, so prepaid expenses, VAT input,
    // current_asset and other_current_asset were current to one surface and
    // absent from the other: 1.11 here against 1.89 in the KPI block of the
    // same export. `fetchBalanceSnapshot` is exported for exactly this, and it
    // carries the account_type guard on both arms, because the invariant is
    // that a liability carrying a bank subtype — an overdraft, a paycard — is
    // not a current ASSET and must not be netted off one.
    fetchBalanceSnapshot(companyId, end),
    sql`
      -- NET movement per side. ABS applied INSIDE the SUM is applied per
      -- journal LINE, so a supplier rebate credited to an expense account
      -- INCREASED the reported expense: revenue R20,000, rent R6,000 less a
      -- R5,000 rebate printed a profit of R9,000 where the income statement
      -- reported R19,000. This figure drives hasConcerns below, so the
      -- defect could flip a statutory going-concern conclusion.
      SELECT SUM(
        CASE WHEN ga.account_type = 'revenue'
             THEN gjl.credit - gjl.debit ELSE 0 END
        -
        CASE WHEN ga.account_type = 'expense'
             THEN gjl.debit - gjl.credit ELSE 0 END
      ) AS net_result
      FROM gl_accounts ga
      JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
        AND gje.entry_date BETWEEN ${start} AND ${end} AND gje.status = 'posted'
      WHERE ga.company_id = ${companyId}
        AND ga.account_type IN ('revenue', 'expense')
    ` as Promise<DbRow[]>,
    getCompanyTerminology(companyId),
  ]);

  const currentAssets = balance.currentAssets;
  const currentLiabilities = balance.currentLiabilities;
  const netResult = toNum((profitRows[0] ?? {}).net_result);

  const currentRatioStr =
    currentLiabilities === 0
      ? 'N/A'
      : (currentAssets / currentLiabilities).toFixed(2);

  const currentRatioNum = currentLiabilities === 0 ? null : currentAssets / currentLiabilities;
  const hasConcerns = (currentRatioNum !== null && currentRatioNum < 1.0) || netResult < 0;

  const resultLabel = netResult >= 0 ? 'profit' : 'loss';

  const blocks: NoteContent['blocks'] = [
    {
      type: 'paragraph',
      text: `The entity has a current ratio of ${currentRatioStr} and ${resultLabel} of R ${fmt(Math.abs(netResult))} for the year.`,
    },
    {
      type: 'paragraph',
      text: `The ${terms.leadership} have assessed ${terms.entityRef}'s ability to continue as a going concern and are satisfied that ${terms.entityRef} will be able to meet its obligations for the foreseeable future. [Accountant: complete if concerns exist]`,
    },
  ];

  if (hasConcerns) {
    blocks.push({
      type: 'paragraph',
      text: `[Going concern concern identified: current ratio below 1.0 or net loss recorded. ${terms.leadershipCapital} must assess and disclose mitigating factors and plans.]`,
    });
  }

  return {
    dataSnapshot: { currentAssets, currentLiabilities, netResult, currentRatioStr, entityType: terms.entityType },
    content: { title: 'Going Concern', blocks },
  };
}

// ── Note 28 — Segment Information ────────────────────────────────────────────

export async function generateNote28SegmentInformation(
  _companyId: string,
  _fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const dataSnapshot = { segments: [] as unknown[], suppressReason: 'not_applicable' };
  const content: NoteContent = {
    title: 'Segment Information',
    blocks: [
      {
        type: 'paragraph',
        text: 'The entity operates as a single reporting segment and does not present segment information. [Accountant: configure segment codes on GL accounts if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 29 — Financial Instruments Risk ─────────────────────────────────────

export async function generateNote29FinancialInstrumentsRisk(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note29: querying financial instruments risk', { companyId, fiscalYear });

  const [creditRiskRows, liquidityRiskRows] = await Promise.all([
    // Credit risk: trade receivables
    sql`
      SELECT ga.account_name, ga.account_code,
             SUM(gjl.debit - gjl.credit) AS balance
      FROM gl_accounts ga
      JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
        AND gje.entry_date <= ${end} AND gje.status = 'posted'
      WHERE ga.company_id = ${companyId}
        AND ga.account_subtype = ANY(${RECEIVABLE_SUBTYPES as string[]}::TEXT[])
      GROUP BY ga.account_name, ga.account_code
      HAVING SUM(gjl.debit - gjl.credit) > 0
    ` as Promise<DbRow[]>,
    // Liquidity risk: payables and borrowings
    sql`
      SELECT ga.account_name, ga.account_code, ga.account_subtype,
             SUM(gjl.credit - gjl.debit) AS balance
      FROM gl_accounts ga
      JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
        AND gje.entry_date <= ${end} AND gje.status = 'posted'
      WHERE ga.company_id = ${companyId}
        AND ga.account_subtype = ANY(${[
          ...PAYABLE_SUBTYPES, 'bank_loan', 'overdraft',
        ] as string[]}::TEXT[])
      GROUP BY ga.account_name, ga.account_code, ga.account_subtype
      HAVING SUM(gjl.credit - gjl.debit) > 0
    ` as Promise<DbRow[]>,
  ]);

  return {
    dataSnapshot: { creditRisk: creditRiskRows, liquidityRisk: liquidityRiskRows },
    content: {
      title: 'Financial Instruments Risk',
      blocks: [
        { type: 'heading', text: 'Credit Risk', level: 3 },
        {
          type: 'paragraph',
          text: 'Maximum credit exposure equals the carrying value of trade and other receivables. [Accountant: describe credit quality and impairment policy]',
        },
        { type: 'heading', text: 'Liquidity Risk', level: 3 },
        {
          type: 'paragraph',
          text: 'The entity manages liquidity risk by monitoring rolling cash flow forecasts. [Accountant: complete maturity analysis of financial liabilities]',
        },
      ],
    },
  };
}

// ── Note 30 — Standards Not Yet Effective ────────────────────────────────────

export async function generateNote30StandardsNotYetEffective(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('note30: querying pending IFRS standards', { fiscalYear });

  // note_templates is a system-wide reference table — no company_id (shared across all tenants)
  const rows = (await sql`
    SELECT nt.standard_reference, nt.title, nt.effective_from, nt.change_summary
    FROM note_templates nt
    WHERE nt.effective_from > ${end}
      AND nt.framework IN ('ifrs_smes', 'both')
      AND nt.supersedes IS NOT NULL
    ORDER BY nt.effective_from ASC
  `) as DbRow[];

  const blocks: NoteContent['blocks'] = [];

  if (rows.length > 0) {
    blocks.push({
      type: 'paragraph',
      text: 'The following new or revised IFRS standards have been issued but are not yet effective:',
    });
    blocks.push({
      type: 'list',
      items: rows.map((r) => {
        const effDate = fmtDate(r.effective_from);
        return `${String(r.standard_reference ?? '')}: ${String(r.title ?? '')} (effective ${effDate})`;
      }),
    });
  } else {
    blocks.push({
      type: 'paragraph',
      text: 'No new IFRS standards are expected to have a significant impact on the entity.',
    });
  }

  return {
    dataSnapshot: { pendingStandards: rows },
    content: { title: 'Standards Not Yet Effective', blocks },
  };
}
