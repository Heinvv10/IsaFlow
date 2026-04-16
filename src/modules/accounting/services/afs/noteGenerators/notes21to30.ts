// src/modules/accounting/services/afs/noteGenerators/notes21to30.ts
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import type { DbRow } from '@/types/db';

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

// ── Note 21 — Finance Costs ───────────────────────────────────────────────────

export async function generateNote21FinanceCosts(
  companyId: string,
  fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const { start, end } = fiscalRange(fiscalYear);

  log.info('note21: querying finance costs', { companyId, fiscalYear });

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

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const dataRows = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(Number(r.amount) || 0),
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
  const { start, end } = fiscalRange(fiscalYear);

  log.info('note22: querying employee benefits', { companyId, fiscalYear });

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

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const dataRows = rows.map((r) => [
    String(r.account_subtype ?? ''),
    fmt(Number(r.amount) || 0),
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
  _companyId: string,
  _fiscalYear: number,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  const dataSnapshot = { parties: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Related Party Disclosures',
    blocks: [
      {
        type: 'paragraph',
        text: 'Related party relationships have not been configured in the system.',
      },
      {
        type: 'paragraph',
        text: '[Accountant: disclose all transactions with directors, shareholders, subsidiaries, and entities under common control]',
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
  const { start, end } = fiscalRange(fiscalYear);

  log.info('note24: querying audit fees', { companyId, fiscalYear });

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
      fmt(Number(r.amount) || 0),
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
      return `${dateStr} — ${String(r.description ?? '')} (${fmt(Number(r.total_amount) || 0)})`;
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

  const [ratioRows, profitRows] = await Promise.all([
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
  ]);

  const ratioRow = ratioRows[0] ?? {};
  const currentAssets = Number(ratioRow.current_assets) || 0;
  const currentLiabilities = Number(ratioRow.current_liabilities) || 0;
  const netResult = Number((profitRows[0] ?? {}).net_result) || 0;

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
      text: 'The directors have assessed the entity\'s ability to continue as a going concern and are satisfied that the entity will be able to meet its obligations for the foreseeable future. [Accountant: complete if concerns exist]',
    },
  ];

  if (hasConcerns) {
    blocks.push({
      type: 'paragraph',
      text: '[Going concern concern identified: current ratio below 1.0 or net loss recorded. Accountant must assess and disclose mitigating factors and plans.]',
    });
  }

  return {
    dataSnapshot: { currentAssets, currentLiabilities, netResult, currentRatioStr },
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
