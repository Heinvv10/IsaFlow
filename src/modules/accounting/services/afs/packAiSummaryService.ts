// src/modules/accounting/services/afs/packAiSummaryService.ts
import Anthropic from '@anthropic-ai/sdk';
import { log } from '@/lib/logger';
import type { KpiResult } from './afsTypes';

const client = new Anthropic();

export interface ExecutiveSummaryParams {
  companyName: string;
  period: string;
  revenue: number;
  priorRevenue: number | null;
  grossMarginPct: number;
  priorGrossMarginPct: number | null;
  ebitda: number;
  closingCash: number;
  cashChange: number;
  debtorDays: number;
  priorDebtorDays: number | null;
  overdueDebtors: number;
  topRevenueAccount: string;
  revenueMovement: number;
  topExpenseAccount: string;
  expenseMovement: number;
  kpis: KpiResult[];
}

export function buildExecutiveSummaryPrompt(params: ExecutiveSummaryParams): string {
  const fmt = (n: number) => n.toLocaleString('en-ZA', { maximumFractionDigits: 0 });
  return `You are a senior financial analyst. Write a concise 3-5 paragraph executive summary for ${params.companyName} for ${params.period}.

Key figures:
- Revenue: R${fmt(params.revenue)} (prior month: ${params.priorRevenue !== null ? `R${fmt(params.priorRevenue)}` : 'N/A'})
- Gross margin: ${params.grossMarginPct.toFixed(1)}% (prior: ${params.priorGrossMarginPct !== null ? `${params.priorGrossMarginPct.toFixed(1)}%` : 'N/A'})
- EBITDA: R${fmt(params.ebitda)}
- Cash: R${fmt(params.closingCash)} (change: R${fmt(params.cashChange)})
- Debtor days: ${params.debtorDays.toFixed(0)} (prior: ${params.priorDebtorDays !== null ? params.priorDebtorDays.toFixed(0) : 'N/A'})
- 60+ day debtors: R${fmt(params.overdueDebtors)}
- Top revenue movement: ${params.topRevenueAccount} R${fmt(params.revenueMovement)}
- Top expense movement: ${params.topExpenseAccount} R${fmt(params.expenseMovement)}

KPI Traffic Lights:
${params.kpis.map(k => `- ${k.label}: ${k.formatted} (${k.rag})`).join('\n')}

Write in plain English. Be specific with numbers. Identify what drove the changes. Note any risks. Do not reference budget comparisons.`;
}

export async function generateExecutiveSummary(params: ExecutiveSummaryParams): Promise<string> {
  const prompt = buildExecutiveSummaryPrompt(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: controller.signal },
    );

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      'Executive summary generation failed',
      { period: params.period, error: message },
      'packAiSummaryService',
    );
    return 'AI summary unavailable for this period.';
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateSectionCommentary(params: {
  sectionType: string;
  sectionData: Record<string, unknown>;
  companyName: string;
  period: string;
  priorData: Record<string, unknown> | null;
}): Promise<string> {
  const prompt = `You are a senior financial analyst. Write a concise 1-2 paragraph commentary for the ${params.sectionType} section of ${params.companyName}'s management accounts for ${params.period}.

Data:
${JSON.stringify(params.sectionData, null, 2)}

${params.priorData ? `Prior period data:\n${JSON.stringify(params.priorData, null, 2)}` : 'No prior period data available.'}

Be specific with numbers. Identify key movements and risks. Do not reference budgets.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      'Section commentary failed',
      { sectionType: params.sectionType, error: message },
      'packAiSummaryService',
    );
    return 'AI commentary unavailable for this section.';
  }
}
