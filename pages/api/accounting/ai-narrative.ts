/**
 * AI Report Narrative API
 * POST: generate management commentary for a financial report
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  buildNarrativePrompt, parseNarrativeResponse, buildVarianceCommentary, buildTrendAnalysis,
  type ReportData, type NarrativeTone, type VarianceItem, type TrendPoint,
} from '@/modules/accounting/services/reportNarrativeService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (checkRateLimit(`ai-narrative:${ip}`, { maxRequests: 30, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
  }

  const { reportData, tone = 'professional', variances, trends } = req.body as {
    reportData: ReportData; tone?: NarrativeTone;
    variances?: VarianceItem[]; trends?: Array<{ points: TrendPoint[]; name: string }>;
  };

  if (!reportData) return apiResponse.badRequest(res, 'reportData is required');

  // Generate variance commentary (no LLM needed)
  const varianceCommentary = variances ? buildVarianceCommentary(variances) : [];

  // Generate trend analysis (no LLM needed)
  const trendAnalysis = trends ? trends.map(t => buildTrendAnalysis(t.points, t.name)) : [];

  // Generate AI narrative
  const prompt = buildNarrativePrompt(reportData, tone);
  let narrative = null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      if (response.ok) {
        const data = await response.json() as any;
        narrative = parseNarrativeResponse(data.content?.[0]?.text || '');
      }
    } catch (err) { log.error('Narrative generation failed', { error: err }, 'ai'); }
  }

  log.info('Report narrative generated', { reportType: reportData.reportType, tone, aiUsed: !!narrative }, 'ai');

  return apiResponse.success(res, {
    narrative: narrative || { summary: 'AI narrative generation requires ANTHROPIC_API_KEY.', highlights: [], concerns: [], recommendations: [] },
    varianceCommentary,
    trendAnalysis,
    aiGenerated: !!narrative,
  });
}
export default withCompany(withErrorHandler(handler));
