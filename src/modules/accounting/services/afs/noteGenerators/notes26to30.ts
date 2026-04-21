// src/modules/accounting/services/afs/noteGenerators/notes26to30.ts
// AFS Note Engine — generators for Notes 26–30

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';
import { fmt, toNum, fiscalRange } from './noteHelpers';
import { getCompanyTerminology } from '../entityTerminology';

// ── Note 26 — Events After Reporting Date ────────────────────────────────────

export async function generateNote26EventsAfterReportingDate(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);

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
      const dateStr =
        r.entry_date instanceof Date
          ? r.entry_date.toISOString().slice(0, 10)
          : String(r.entry_date ?? '');
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
  const { start, end } = fiscalRange(fiscalYear);

  log.info('note27: querying going concern indicators', { companyId, fiscalYear });

  const [ratioRows, profitRows, terms] = await Promise.all([
    sql`
      SELECT
        SUM(CASE WHEN ga.account_subtype IN ('bank','cash','trade_receivable','inventory')
                 THEN gjl.debit - gjl.credit ELSE 0 END) AS current_assets,
        SUM(CASE WHEN ga.account_subtype IN ('trade_payable','vat_payable','overdraft',
                                              'current_tax_liability')
                 THEN gjl.credit - gjl.debit ELSE 0 END) AS current_liabilities
      FROM gl_accounts ga
      JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
        AND gje.entry_date <= ${end} AND gje.status = 'posted'
      WHERE ga.company_id = ${companyId}
    ` as Promise<DbRow[]>,
    sql`
      SELECT SUM(
        CASE WHEN ga.account_type = 'revenue'
             THEN ABS(gjl.credit - gjl.debit) ELSE 0 END
        -
        CASE WHEN ga.account_type = 'expense'
             THEN ABS(gjl.debit - gjl.credit) ELSE 0 END
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

  const ratioRow = ratioRows[0] ?? {};
  const currentAssets = toNum(ratioRow.current_assets);
  const currentLiabilities = toNum(ratioRow.current_liabilities);
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
  const { end } = fiscalRange(fiscalYear);

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
        AND ga.account_subtype = 'trade_receivable'
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
        AND ga.account_subtype IN ('trade_payable', 'bank_loan', 'overdraft')
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
  _companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { end } = fiscalRange(fiscalYear);

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
        const effDate =
          r.effective_from instanceof Date
            ? r.effective_from.toISOString().slice(0, 10)
            : String(r.effective_from ?? '');
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
