// src/modules/accounting/services/afs/noteGenerators/primaryStatements.ts
// AFS Primary Statement generators — Income Statement, Balance Sheet,
// Cash Flow, Statement of Changes in Equity, Director's Report, Cover.
//
// These render the hierarchical line catalogue from afs_statement_lines
// (seeded by mig 472) joined to afs_account_mappings (set up by
// autoMapAccounts) and the posted GL. A line with `is_header=true`
// renders as a section heading; `is_total=true` as a sub/grand total;
// everything else as a leaf line with its current/prior amount.
//
// Tenant scope: every query filters by ${companyId}. Aggregator at the
// portfolio level wraps these in a BYPASSRLS tx with the right GUC, so
// these are safe to call from either the request tx or the portfolio
// loop.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum, fiscalRange } from './noteHelpers';
import { getCompanyTerminology } from '../entityTerminology';

type DbRow = Record<string, unknown>;

interface SectionLine {
  code: string;
  label: string;
  parentCode: string | null;
  noteNumber: number | null;
  sortOrder: number;
  isHeader: boolean;
  isTotal: boolean;
  currentAmount: number;
  priorAmount: number;
}

async function fetchSectionLines(
  companyId: string,
  section: 'balance_sheet' | 'income_statement',
  fiscalYear: number,
  priorYear?: number,
): Promise<SectionLine[]> {
  const { start, end } = fiscalRange(fiscalYear);
  const priorStart = priorYear ? `${priorYear}-01-01` : null;
  const priorEnd = priorYear ? `${priorYear}-12-31` : null;

  // Balance sheet is point-in-time (cumulative balance up to year end);
  // income statement is period-flow (entries within the fiscal year).
  // For BS, sum every posted JE up to and including end-of-year.
  // For IS, sum only entries within [start, end].
  const isBs = section === 'balance_sheet';

  const rows = (await sql`
    SELECT
      sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order,
      sl.is_header, sl.is_total,
      COALESCE(SUM(
        CASE
          WHEN am.gl_account_id IS NULL THEN 0
          WHEN ${isBs}::boolean
            THEN CASE WHEN gje.entry_date <= ${end}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
          ELSE CASE WHEN gje.entry_date BETWEEN ${start}::date AND ${end}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
        END
      ), 0) AS current_amount,
      COALESCE(SUM(
        CASE
          WHEN am.gl_account_id IS NULL OR ${priorEnd}::date IS NULL THEN 0
          WHEN ${isBs}::boolean
            THEN CASE WHEN gje.entry_date <= ${priorEnd}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
          ELSE CASE WHEN gje.entry_date BETWEEN ${priorStart}::date AND ${priorEnd}::date THEN (gjl.debit - gjl.credit) ELSE 0 END
        END
      ), 0) AS prior_amount
    FROM afs_statement_lines sl
    LEFT JOIN afs_account_mappings am ON am.afs_line_code = sl.code AND am.company_id = sl.company_id
    LEFT JOIN gl_journal_lines gjl ON gjl.gl_account_id = am.gl_account_id AND gjl.company_id = ${companyId}::uuid
    LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted'
    WHERE sl.company_id = ${companyId}::uuid
      AND sl.section = ${section}
      AND sl.is_active = true
    GROUP BY sl.code, sl.label, sl.parent_code, sl.note_number, sl.sort_order, sl.is_header, sl.is_total
    ORDER BY sl.sort_order
  `) as DbRow[];

  return rows.map((r) => ({
    code: String(r.code),
    label: String(r.label),
    parentCode: r.parent_code != null ? String(r.parent_code) : null,
    noteNumber: r.note_number != null ? Number(r.note_number) : null,
    sortOrder: Number(r.sort_order ?? 0),
    isHeader: Boolean(r.is_header),
    isTotal: Boolean(r.is_total),
    currentAmount: toNum(r.current_amount),
    priorAmount: toNum(r.prior_amount),
  }));
}

function rollUpTotals(lines: SectionLine[]): SectionLine[] {
  // For each is_total line whose amount is 0, sum its siblings (lines with
  // the same parent_code that are neither headers nor totals). Skips lines
  // with non-zero amounts so accountant-written overrides aren't clobbered.
  const byParent = new Map<string, SectionLine[]>();
  for (const l of lines) {
    if (l.parentCode && !l.isHeader && !l.isTotal) {
      const arr = byParent.get(l.parentCode) ?? [];
      arr.push(l);
      byParent.set(l.parentCode, arr);
    }
  }
  return lines.map((l) => {
    if (!l.isTotal || (l.currentAmount !== 0 && l.priorAmount !== 0)) return l;
    const siblings = byParent.get(l.parentCode ?? '') ?? [];
    if (siblings.length === 0) return l;
    return {
      ...l,
      currentAmount: l.currentAmount === 0 ? siblings.reduce((s, x) => s + x.currentAmount, 0) : l.currentAmount,
      priorAmount: l.priorAmount === 0 ? siblings.reduce((s, x) => s + x.priorAmount, 0) : l.priorAmount,
    };
  });
}

function renderHierarchicalTable(
  lines: SectionLine[],
  hasPriorYear: boolean,
  flipSign: boolean,
): NoteContent['blocks'] {
  // Hide leaf lines whose code is not in mappings AND have zero amounts
  // both years — they'd just clutter the statement.
  const visible = lines.filter((l) => l.isHeader || l.isTotal || l.currentAmount !== 0 || l.priorAmount !== 0);

  const headers = hasPriorYear
    ? ['Line', 'Current year (R)', 'Prior year (R)']
    : ['Line', 'Current year (R)'];

  const rows: string[][] = [];
  for (const l of visible) {
    const indent = l.parentCode ? '  ' : '';
    const labelPrefix = l.isTotal ? `${indent}**${l.label}**` : `${indent}${l.label}`;
    if (l.isHeader) {
      rows.push([`**${l.label}**`, '', ...(hasPriorYear ? [''] : [])]);
      continue;
    }
    const sign = flipSign ? -1 : 1;
    const cur = sign * l.currentAmount;
    const prior = sign * l.priorAmount;
    if (hasPriorYear) {
      rows.push([labelPrefix, fmt(cur), fmt(prior)]);
    } else {
      rows.push([labelPrefix, fmt(cur)]);
    }
  }
  return [{ type: 'table', headers, rows }];
}

// ── Statement of Financial Position (Balance Sheet) ─────────────────────────

export async function generateStatementOfFinancialPosition(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateStatementOfFinancialPosition', { companyId, fiscalYear }, 'AfsPrimary');
  const lines = rollUpTotals(await fetchSectionLines(companyId, 'balance_sheet', fiscalYear, fiscalYear - 1));
  // Asset balances are debit-positive in the GL (DR-CR > 0). Liability +
  // equity are credit-positive (DR-CR < 0). Flip the sign so liabilities
  // and equity render as positive numbers on the BS.
  const adjusted = lines.map((l) => {
    const isAssetBranch = l.code.startsWith('BS00') || l.code.startsWith('BS01') || l.code.startsWith('BS02') || l.code.startsWith('BS03');
    return isAssetBranch ? l : { ...l, currentAmount: -l.currentAmount, priorAmount: -l.priorAmount };
  });
  const blocks = renderHierarchicalTable(adjusted, true, false);
  return {
    dataSnapshot: { lines },
    content: {
      title: 'Statement of Financial Position',
      blocks: [
        { type: 'paragraph', text: `As at ${fiscalRange(fiscalYear).end}.` },
        ...blocks,
      ],
    },
  };
}

// ── Income Statement ────────────────────────────────────────────────────────

export async function generateIncomeStatement(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateIncomeStatement', { companyId, fiscalYear }, 'AfsPrimary');
  const lines = rollUpTotals(await fetchSectionLines(companyId, 'income_statement', fiscalYear, fiscalYear - 1));
  // Revenue is credit-positive (DR-CR < 0); expenses are debit-positive.
  // Flip revenue lines so the IS reads as Revenue (positive) less Expenses
  // (positive).
  const adjusted = lines.map((l) => {
    const isRevenueBranch = l.code.startsWith('IS00') || l.code.startsWith('IS01') || l.code === 'IS124' || l.parentCode === 'IS124';
    return isRevenueBranch
      ? { ...l, currentAmount: -l.currentAmount, priorAmount: -l.priorAmount }
      : l;
  });
  const blocks = renderHierarchicalTable(adjusted, true, false);
  return {
    dataSnapshot: { lines },
    content: {
      title: 'Statement of Profit or Loss',
      blocks: [
        { type: 'paragraph', text: `For the year ended ${fiscalRange(fiscalYear).end}.` },
        ...blocks,
      ],
    },
  };
}

// ── Cash Flow Statement ─────────────────────────────────────────────────────

export async function generateCashFlow(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateCashFlow', { companyId, fiscalYear }, 'AfsPrimary');
  // V1: indirect-method skeleton — opening cash, profit, working-capital
  // movements rollup, closing cash. Pulls just enough to render a
  // recognisable cash-flow statement; full IFRS-compliant indirect method
  // (separating operating/investing/financing) is a follow-up.
  const { start, end } = fiscalRange(fiscalYear);
  const cashRows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN gje.entry_date < ${start}::date THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS opening,
      COALESCE(SUM(CASE WHEN gje.entry_date <= ${end}::date THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS closing
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}::uuid
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}::uuid
      AND ga.account_subtype IN ('bank', 'cash', 'petty_cash')
  `) as DbRow[];
  const opening = toNum(cashRows[0]?.opening);
  const closing = toNum(cashRows[0]?.closing);
  const netMovement = closing - opening;

  return {
    dataSnapshot: { opening, closing, netMovement },
    content: {
      title: 'Statement of Cash Flows',
      blocks: [
        { type: 'paragraph', text: `For the year ended ${end}. Indirect method.` },
        {
          type: 'table',
          headers: ['Line', 'Current year (R)'],
          rows: [
            ['Cash and equivalents at beginning of year', fmt(opening)],
            ['Net movement during year', fmt(netMovement)],
            ['**Cash and equivalents at end of year**', fmt(closing)],
          ],
        },
        { type: 'paragraph', text: 'Detailed operating, investing and financing cash flows are pending implementation.' },
      ],
    },
  };
}

// ── Statement of Changes in Equity ──────────────────────────────────────────

export async function generateChangesInEquity(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateChangesInEquity', { companyId, fiscalYear }, 'AfsPrimary');
  const lines = await fetchSectionLines(companyId, 'balance_sheet', fiscalYear, fiscalYear - 1);
  const equityCodes = new Set(['BS043', 'BS044', 'BS045', 'BS046', 'BS047', 'BS048']);
  const equityLines = lines.filter((l) => equityCodes.has(l.code));

  const rows: string[][] = equityLines.map((l) => [
    l.label,
    fmt(-l.priorAmount),
    fmt(-(l.currentAmount - l.priorAmount)),
    fmt(-l.currentAmount),
  ]);

  return {
    dataSnapshot: { equityLines },
    content: {
      title: 'Statement of Changes in Equity',
      blocks: [
        { type: 'paragraph', text: `Movements in equity for the year ended ${fiscalRange(fiscalYear).end}.` },
        {
          type: 'table',
          headers: ['Component', 'Opening (R)', 'Movement (R)', 'Closing (R)'],
          rows,
        },
      ],
    },
  };
}

// ── Director's Report ───────────────────────────────────────────────────────

export async function generateDirectorsReport(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateDirectorsReport', { companyId, fiscalYear }, 'AfsPrimary');
  const term = await getCompanyTerminology(companyId);

  return {
    dataSnapshot: { fiscalYear },
    content: {
      title: `${term.leadershipCapital} Report`,
      blocks: [
        { type: 'heading', level: 2, text: 'Nature of business' },
        { type: 'paragraph', text: `The ${term.entityRef} carries on the business as detailed in the principal activities. The ${term.leadership} confirm there have been no material changes during the period.` },
        { type: 'heading', level: 2, text: 'Review of activities' },
        { type: 'paragraph', text: `The financial results for the year ended ${fiscalRange(fiscalYear).end} are reflected in the annexed financial statements.` },
        { type: 'heading', level: 2, text: 'Going concern' },
        { type: 'paragraph', text: `The ${term.leadership} have reviewed the entity's projected cash flow and operating budgets and consider that the entity has adequate resources to continue as a going concern for the foreseeable future.` },
        { type: 'heading', level: 2, text: 'Events after the reporting date' },
        { type: 'paragraph', text: `The ${term.leadership} are not aware of any matter or circumstance arising since the end of the financial year that requires adjustment to or disclosure in the financial statements.` },
        { type: 'heading', level: 2, text: 'Auditor' },
        { type: 'paragraph', text: `The auditor will be appointed at the next annual general meeting in accordance with the ${term.actReference}.` },
      ],
    },
  };
}

// ── Cover ───────────────────────────────────────────────────────────────────

export async function generateCover(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateCover', { companyId, fiscalYear }, 'AfsPrimary');
  const rows = (await sql`
    SELECT name, registered_name, registration_number, vat_number
    FROM companies WHERE id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const c = rows[0] ?? {};

  return {
    dataSnapshot: { fiscalYear, company: c },
    content: {
      title: 'Annual Financial Statements',
      blocks: [
        { type: 'heading', level: 2, text: String(c.registered_name ?? c.name ?? '') },
        { type: 'paragraph', text: `Registration: ${String(c.registration_number ?? '—')}` },
        { type: 'paragraph', text: `VAT: ${String(c.vat_number ?? '—')}` },
        { type: 'paragraph', text: `For the year ended ${fiscalRange(fiscalYear).end}` },
      ],
    },
  };
}
