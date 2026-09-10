// src/modules/accounting/services/afs/managementPackGeneratorService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createAfsDocument } from './afsDocumentService';
import { createAfsSection, updateAfsSection } from './afsSectionService';
import { getKpiScorecard } from './afsKpiService';
import { generateExecutiveSummary, generateSectionCommentary } from './packAiSummaryService';
import type { ManagementPackConfig, NoteContent, KpiResult } from './afsTypes';

type Row = DbRow;

/**
 * A pack generated without review used to be written straight to 'signed_off' — the status that
 * LOCKS a document — with no signatory, and delivered. There is no status for "published without
 * a signature" yet (the follow-up), and inventing one here would change a vocabulary the review
 * workflow, the portal and the section write guard all read. Until it exists the pack is still
 * generated, as a draft a person can open and send on, but it is NOT delivered — and the caller
 * and the scheduler are told why, so nobody is left wondering where the month's pack went.
 */
export const UNREVIEWED_PACK_NOT_DELIVERED =
  'Not delivered: a pack that skips review needs a published status that is not yet available. '
  + 'The draft is ready to review and send by hand.';

export class DuplicatePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicatePackError';
  }
}

export interface GeneratePackOptions {
  companyId: string;
  period: string;       // 'YYYY-MM'
  config: ManagementPackConfig;
  triggeredBy: 'cron' | 'manual';
}

export interface GeneratePackResult {
  documentId: string;
  sectionsGenerated: number;
  status: 'draft';
  deliveryScheduled: boolean;
  /** Why no pack went out, when none did. Null when delivery follows the normal review path. */
  deliveryWithheldReason: string | null;
}

interface PackData {
  kpis: KpiResult[];
  income: Record<string, unknown>;
  balance: Record<string, unknown>;
  priorIncome: Record<string, unknown>;
}

// ── Section renderers ────────────────────────────────────────────────────────

function renderSection(sectionType: string, data: PackData): NoteContent {
  switch (sectionType) {
    case 'kpi_scorecard':
      return {
        title: 'KPI Scorecard',
        blocks: [{
          type: 'table',
          headers: ['KPI', 'Value', 'Trend', 'RAG'],
          rows: data.kpis.map(k => [k.label, k.formatted, k.trend, k.rag]),
        }],
      };
    case 'income_statement':
      return { title: 'Income Statement', blocks: [{ type: 'paragraph', text: JSON.stringify(data.income) }] };
    case 'balance_sheet':
      return { title: 'Balance Sheet', blocks: [{ type: 'paragraph', text: JSON.stringify(data.balance) }] };
    default:
      return { title: sectionType, blocks: [] };
  }
}

// ── Period helpers ───────────────────────────────────────────────────────────

function periodBounds(period: string): { start: string; end: string } {
  const parts = period.split('-');
  const y = Number(parts[0] ?? 2000);
  const m = Number(parts[1] ?? 1);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  return { start, end: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

function priorPeriod(period: string): string {
  const parts = period.split('-');
  const y = Number(parts[0] ?? 2000);
  const m = Number(parts[1] ?? 1);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function fetchIncomeAgg(companyId: string, start: string, end: string): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'cost_of_sales' THEN jl.debit - jl.credit ELSE 0 END), 0) AS cogs,
      COALESCE(SUM(CASE
        WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
        WHEN ga.account_type = 'expense' THEN -(jl.debit - jl.credit)
        ELSE 0 END), 0) AS net_profit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${start}::date
      AND je.entry_date <= ${end}::date
  `) as Row[];
  return (rows[0] ?? {}) as Record<string, unknown>;
}

async function fetchBalanceAgg(companyId: string, end: string): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'asset' AND ga.account_subtype NOT IN ('fixed_asset','accumulated_depreciation') THEN jl.debit - jl.credit ELSE 0 END), 0) AS current_assets,
      COALESCE(SUM(CASE WHEN ga.account_type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0) AS current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_type = 'equity' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_equity
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${end}::date
  `) as Row[];
  return (rows[0] ?? {}) as Record<string, unknown>;
}

async function fetchTopMover(companyId: string, start: string, end: string, type: 'revenue' | 'expense'): Promise<{ name: string; amount: number }> {
  const rows = (await sql`
    SELECT ga.account_name,
      SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${start}::date
      AND je.entry_date <= ${end}::date
      AND ga.account_type = ${type}
    GROUP BY ga.id, ga.account_name
    ORDER BY ABS(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)) DESC
    LIMIT 1
  `) as Row[];
  return { name: String(rows[0]?.account_name ?? 'N/A'), amount: Number(rows[0]?.amount ?? 0) };
}

async function fetchCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1`) as Row[];
  return String(rows[0]?.name ?? 'Unknown Company');
}

async function checkExisting(companyId: string, period: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM afs_documents
    WHERE company_id = ${companyId}::UUID AND document_type = 'management_pack' AND period = ${period}
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function generateManagementPack(options: GeneratePackOptions): Promise<GeneratePackResult> {
  const { companyId, period, config, triggeredBy } = options;
  log.info('Starting management pack generation', { companyId, period, triggeredBy }, 'managementPackGeneratorService');

  if (await checkExisting(companyId, period)) {
    throw new DuplicatePackError(`Management pack already generated for period ${period}`);
  }

  const doc = await createAfsDocument({
    companyId, period, documentType: 'management_pack', reportingFramework: 'ifrs_smes',
  });

  const { start, end } = periodBounds(period);
  const prior = priorPeriod(period);
  const { start: priorStart, end: priorEnd } = periodBounds(prior);

  const enabledSections = Object.entries(config.sectionsEnabled)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const sectionRows = await Promise.all(
    enabledSections.map((sectionType, idx) =>
      createAfsSection({
        documentId: doc.id, companyId,
        // Management pack uses string-keyed sections that extend beyond SectionType union
        sectionType: sectionType as import('./afsTypes').SectionType,
        sortOrder: idx,
      }),
    ),
  );

  const [income, balance, priorIncome, kpiScorecard, companyName, topRevenue, topExpense] =
    await Promise.all([
      fetchIncomeAgg(companyId, start, end),
      fetchBalanceAgg(companyId, end),
      fetchIncomeAgg(companyId, priorStart, priorEnd),
      getKpiScorecard(companyId, period),
      fetchCompanyName(companyId),
      fetchTopMover(companyId, start, end, 'revenue'),
      fetchTopMover(companyId, start, end, 'expense'),
    ]);

  const packData: PackData = { kpis: kpiScorecard.kpis, income, balance, priorIncome };

  for (const section of sectionRows) {
    const content = renderSection(section.sectionType, packData);
    await updateAfsSection(section.id, doc.id, companyId, {
      dataSnapshot: income, content, status: 'auto_generated',
    });
  }

  const grossKpi = kpiScorecard.kpis.find(k => k.key === 'grossMarginPct');
  const debtorKpi = kpiScorecard.kpis.find(k => k.key === 'debtorDays');

  const aiSummary = await generateExecutiveSummary({
    companyName, period,
    revenue: Number(income.revenue ?? 0),
    priorRevenue: Number(priorIncome.revenue ?? 0),
    grossMarginPct: grossKpi?.value ?? 0,
    priorGrossMarginPct: grossKpi?.priorValue ?? null,
    ebitda: 0, closingCash: 0, cashChange: 0,
    debtorDays: debtorKpi?.value ?? 0,
    priorDebtorDays: debtorKpi?.priorValue ?? null,
    overdueDebtors: 0,
    topRevenueAccount: topRevenue.name, revenueMovement: topRevenue.amount,
    topExpenseAccount: topExpense.name, expenseMovement: topExpense.amount,
    kpis: kpiScorecard.kpis,
  });

  const commentaryResults = await Promise.allSettled(
    sectionRows.map(section =>
      generateSectionCommentary({
        sectionType: section.sectionType, sectionData: income,
        companyName, period, priorData: priorIncome,
      }).then(commentary => ({ sectionId: section.id, docId: doc.id, commentary })),
    ),
  );

  await Promise.all(
    commentaryResults.map(result => {
      if (result.status === 'fulfilled') {
        return updateAfsSection(result.value.sectionId, result.value.docId, companyId, {
          aiNarrative: result.value.commentary, status: 'ai_enhanced',
        });
      }
      log.warn(
        'Section commentary failed, skipping',
        { error: String(result.reason) },
        'managementPackGeneratorService',
      );
      return Promise.resolve();
    }),
  );

  const execSection = sectionRows.find(s => String(s.sectionType) === 'ai_executive_summary');
  if (execSection) {
    await updateAfsSection(execSection.id, doc.id, companyId, {
      aiNarrative: aiSummary, status: 'ai_enhanced',
    });
  }

  // Always a draft: nothing here is signed, so nothing may claim a status that says it is.
  const finalStatus = 'draft' as const;

  // Delivery follows the review, as it always has. A pack that skips review is generated and
  // held back — and the hold is written ON THE DOCUMENT, because a return value gates nothing:
  // deliverPack reads this column, and only a document sign-off clears it.
  const deliveryScheduled = false;
  const deliveryWithheldReason = config.reviewRequired ? null : UNREVIEWED_PACK_NOT_DELIVERED;

  await sql`
    UPDATE afs_documents
    SET status = ${finalStatus},
        delivery_withheld_reason = ${deliveryWithheldReason},
        updated_at = NOW()
    WHERE id = ${doc.id}::UUID AND company_id = ${companyId}::UUID
  `;

  if (deliveryWithheldReason) {
    log.warn('Pack generated but not delivered', { companyId, period, documentId: doc.id, reason: deliveryWithheldReason }, 'managementPackGeneratorService');
  }

  log.info('Pack generated', { companyId, period, documentId: doc.id, finalStatus, deliveryWithheldReason }, 'managementPackGeneratorService');
  return { documentId: doc.id, sectionsGenerated: sectionRows.length, status: finalStatus, deliveryScheduled, deliveryWithheldReason };
}
