// src/modules/accounting/services/afs/managementPackGeneratorService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rawSubtypesFor } from '../gl/accountSubtypes';
import { orderedEnabledSections } from './managementPackConfigService';
import { createAfsDocument } from './afsDocumentService';
import { createAfsSection, updateAfsSection } from './afsSectionService';
import { getKpiScorecard } from './afsKpiService';
import { getBalanceSheet } from '../reports/balanceSheetService';
import { getIncomeStatement } from '../reports/incomeStatementService';
import { AI_COMMENTARY_UNAVAILABLE, AI_SUMMARY_UNAVAILABLE } from './managementPackSections';
import {
  commentaryInput, hasCommentary, incomeAggregate, renderSection, renderSnapshot, type PackData, type Periodic,
} from './managementPackSectionContent';
import { generateExecutiveSummary, generateSectionCommentary } from './packAiSummaryService';
import { deliverPack } from './packDeliveryService';
import {
  comparisonPlan, isBudgetSection, loadPackBudget, narrativePrior, samePeriodLastYear,
} from './managementPackComparison';
import { readAgeing, readReconciliations, readSafely } from './managementPackReads';
import { getCashFlowDirect } from './cashFlowDirectService';
import { loadPackVarianceNoteBlocks } from './managementPackVarianceNotes';
import type { ManagementPackConfig } from './afsTypes';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

type Row = DbRow;

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
  status: 'draft' | 'signed_off';
  deliveryScheduled: boolean;
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

export async function fetchIncomeAgg(companyId: string, start: string, end: string): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${rawSubtypesFor('cost_of_sales')}::TEXT[]) THEN jl.debit - jl.credit ELSE 0 END), 0) AS cogs,
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
      AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.entry_date >= ${start}::date
      AND je.entry_date <= ${end}::date
  `) as Row[];
  return (rows[0] ?? {}) as Record<string, unknown>;
}

export async function fetchTopMover(companyId: string, start: string, end: string, type: 'revenue' | 'expense'): Promise<{ name: string; amount: number }> {
  const rows = (await sql`
    SELECT ga.account_name,
      SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
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

  const enabledSections = orderedEnabledSections(config.sectionsEnabled);

  const plan = comparisonPlan(config.comparisonMode);
  // Before the document: a fault here must not leave a half-made pack that blocks the month's re-run.
  const budget = plan.budget || enabledSections.some(isBudgetSection) ? await loadPackBudget(companyId, period) : null;
  const varianceNotes = budget?.kind === 'report' && enabledSections.includes('budget_variance')
    ? await loadPackVarianceNoteBlocks(companyId, budget.report) : [];

  const { start, end } = periodBounds(period);
  const prior = priorPeriod(period);
  const { start: priorStart, end: priorEnd } = periodBounds(prior);
  const { start: yearAgoStart, end: yearAgoEnd } = periodBounds(samePeriodLastYear(period));

  // The income statement also feeds the AI summary and the figures stored beside it, so they cannot disagree with the table.
  const wantsIncome = enabledSections.includes('income_statement') || enabledSections.includes('ai_executive_summary');
  const wantsBalance = enabledSections.includes('balance_sheet');
  // The sections are the Reports' own figures: the same services, over the same windows (managementPackReads.readSafely).
  // Only a refusal (no system account) leaves its section saying so; any other fault aborts the pack. All reads come before the
  // document is created, so an aborted run leaves nothing that blocks the month's re-run.
  const ctx = { companyId, period };
  const periodic = <R>(name: string, read: (w: { start: string; end: string }) => Promise<R>): Promise<Periodic<R> | null> =>
    readSafely(ctx, name, async () => {
      const current = await read({ start, end });
      const priorR = plan.priorMonth ? await read({ start: priorStart, end: priorEnd }) : null;
      const yearAgo = plan.priorYear ? await read({ start: yearAgoStart, end: yearAgoEnd }) : null;
      return { current, prior: priorR, yearAgo };
    });
  const incomeReports = wantsIncome ? await periodic('income', (w) => getIncomeStatement(companyId, w.start, w.end)) : null;
  const balanceReports = wantsBalance ? await periodic('balance', (w) => getBalanceSheet(companyId, w.end)) : null;
  const cashFlowReports = enabledSections.includes('cash_flow') ? await periodic('cash_flow', (w) => getCashFlowDirect(companyId, w.start, w.end)) : null;
  const debtorsAging = enabledSections.includes('debtors_ageing') ? await readAgeing(ctx, 'ar', end) : null;
  const creditorsAging = enabledSections.includes('creditors_ageing') ? await readAgeing(ctx, 'ap', end) : null;
  const reconciliations = enabledSections.includes('bank_reconciliation') ? await readReconciliations(ctx) : null;

  // A section whose report could not be read says so; a pack with such a section is not signed off and sent on its own.
  const unproduced = [
    ['income statement', wantsIncome, incomeReports], ['balance sheet', wantsBalance, balanceReports], ['cash flow', enabledSections.includes('cash_flow'), cashFlowReports],
    ['debtors ageing', enabledSections.includes('debtors_ageing'), debtorsAging], ['creditors ageing', enabledSections.includes('creditors_ageing'), creditorsAging],
    ['bank reconciliation', enabledSections.includes('bank_reconciliation'), reconciliations],
  ].filter(([, wanted, report]) => wanted && report === null).map(([name]) => String(name));

  const doc = await createAfsDocument({
    companyId, period, documentType: 'management_pack', reportingFramework: 'ifrs_smes',
  });

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

  const [kpiScorecard, companyName, topRevenue, topExpense] = await Promise.all([
    getKpiScorecard(companyId, period),
    fetchCompanyName(companyId),
    fetchTopMover(companyId, start, end, 'revenue'),
    fetchTopMover(companyId, start, end, 'expense'),
  ]);
  // The figures the AI is told and the snapshot keeps are the statement's own (turnover, cost of sales, net profit).
  const income = incomeAggregate(incomeReports?.current);
  const priorIncome = incomeAggregate(incomeReports?.prior);
  const priorYearIncome = incomeReports?.yearAgo ? incomeAggregate(incomeReports.yearAgo) : null;

  const packData: PackData = {
    kpis: kpiScorecard.kpis, income, priorIncome, priorYearIncome, incomeReports, balanceReports,
    cashFlowReports, debtorsAging, creditorsAging, reconciliations, periodEnd: end,
    plan, budget, varianceNotes, enabledSections,
  };
  const narrative = narrativePrior(packData, plan);

  for (const section of sectionRows) {
    const content = renderSection(section.sectionType, packData);
    await updateAfsSection(section.id, doc.id, companyId, {
      dataSnapshot: renderSnapshot(section.sectionType, packData),
      content, status: 'auto_generated',
    });
  }

  const grossKpi = kpiScorecard.kpis.find(k => k.key === 'grossMarginPct');
  const debtorKpi = kpiScorecard.kpis.find(k => k.key === 'debtorDays');

  const wantsSummary = enabledSections.includes('ai_executive_summary') && incomeReports !== null;
  const aiSummary = !wantsSummary ? '' : await generateExecutiveSummary({
    companyName, period,
    revenue: Number(income.revenue ?? 0),
    priorRevenue: narrative.revenue,
    priorLabel: narrative.label,
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
    sectionRows.filter(section => hasCommentary(section.sectionType, packData)).map(section => {
      const { sectionData, priorData } = commentaryInput(section.sectionType, packData, narrative.priorData);
      return generateSectionCommentary({ sectionType: section.sectionType, sectionData, companyName, period, priorData })
        .then(commentary => ({ sectionId: section.id, docId: doc.id, commentary }));
    }),
  );

  await Promise.all(
    commentaryResults.map(result => {
      if (result.status === 'fulfilled') {
        // The AI call's failure sentence is not commentary: leave the section without a narrative.
        if (result.value.commentary.trim() === '' || result.value.commentary === AI_COMMENTARY_UNAVAILABLE) return Promise.resolve();
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
  if (execSection && aiSummary.trim() !== '' && aiSummary !== AI_SUMMARY_UNAVAILABLE) {
    await updateAfsSection(execSection.id, doc.id, companyId, {
      aiNarrative: aiSummary, status: 'ai_enhanced',
    });
  }

  const heldForReview = config.reviewRequired || unproduced.length > 0;
  if (unproduced.length > 0 && !config.reviewRequired) {
    log.warn('management pack: held for review, not signed off or delivered: a section could not be produced',
      { companyId, period, documentId: doc.id, sections: unproduced }, 'managementPackGeneratorService');
  }
  const finalStatus: 'draft' | 'signed_off' = heldForReview ? 'draft' : 'signed_off';

  await sql`
    UPDATE afs_documents SET status = ${finalStatus}, updated_at = NOW()
    WHERE id = ${doc.id}::UUID AND company_id = ${companyId}::UUID
  `;

  let deliveryScheduled = false;
  if (!heldForReview) {
    await deliverPack(doc.id, companyId);
    deliveryScheduled = true;
  }

  log.info('Pack generated', { companyId, period, documentId: doc.id, finalStatus }, 'managementPackGeneratorService');
  return { documentId: doc.id, sectionsGenerated: sectionRows.length, status: finalStatus, deliveryScheduled };
}
