/**
 * AI Cash Flow Forecast API
 * POST: generate scenario-based forecast with AI narrative
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  buildForecastScenario, calculateWeeklyForecast,
  buildForecastNarrativePrompt, parseForecastNarrative,
} from '@/modules/accounting/services/cashFlowAIService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { baseRevenue = 0, baseExpenses = 0, cashBalance = 0, months = 6, weeklyMode = false } = req.body;

  // Generate scenarios
  const scenarios = {
    optimistic: buildForecastScenario('optimistic', { baseRevenue, baseExpenses, cashBalance, months }),
    base: buildForecastScenario('base', { baseRevenue, baseExpenses, cashBalance, months }),
    pessimistic: buildForecastScenario('pessimistic', { baseRevenue, baseExpenses, cashBalance, months }),
  };

  // 13-week rolling if requested
  const weekly = weeklyMode ? calculateWeeklyForecast({
    openingBalance: cashBalance,
    weeklyInflow: baseRevenue / 4.33,
    weeklyOutflow: baseExpenses / 4.33,
    weeks: 13,
    minimumBalance: cashBalance * 0.1,
  }) : null;

  // AI narrative
  const lastBase = scenarios.base.points[scenarios.base.points.length - 1];
  let narrative = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && lastBase) {
    try {
      const prompt = buildForecastNarrativePrompt({
        currentBalance: cashBalance, projectedBalance: lastBase.closingBalance,
        months, lowestPoint: Math.min(...scenarios.pessimistic.points.map(p => p.closingBalance)),
        lowestMonth: `Month ${scenarios.pessimistic.points.findIndex(p => p.closingBalance === Math.min(...scenarios.pessimistic.points.map(pp => pp.closingBalance))) + 1}`,
      });
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
      });
      if (response.ok) {
        const data = await response.json() as any;
        narrative = parseForecastNarrative(data.content?.[0]?.text || '');
      }
    } catch (err) { log.error('Forecast narrative failed', { error: err }, 'ai'); }
  }

  const allAlerts = [...scenarios.optimistic.alerts, ...scenarios.base.alerts, ...scenarios.pessimistic.alerts];

  log.info('AI forecast generated', { months, hasNarrative: !!narrative }, 'ai');

  return apiResponse.success(res, { scenarios, weekly, narrative, alerts: allAlerts, aiGenerated: !!narrative });
}
export default withCompany(withErrorHandler(handler));
