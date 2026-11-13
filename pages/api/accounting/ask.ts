/**
 * "Ask IsaFlow" (wave 5 M11): GET /api/accounting/ask?q=<question>
 * A fixed set of question patterns answered by the same read-only services the MCP tools wrap. No model, nothing
 * is written. An unrecognised question answers `understood: false` with example questions.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { todayInSast } from '@/lib/saDateParser';
import { resolveProvider } from '@/modules/accounting/services/ask/askProvider';
import { answerQuestion } from '@/modules/accounting/services/ask/askAnswer';

const MAX_QUESTION = 300;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return apiResponse.badRequest(res, 'q is required');
  if (q.length > MAX_QUESTION) return apiResponse.badRequest(res, `q must be at most ${MAX_QUESTION} characters`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.mode === 'free') {
    const provider = resolveProvider();
    if (!provider) return apiResponse.badRequest(res, 'Free-text questions are not enabled');
    return apiResponse.success(res, await provider.answer(companyId, q));
  }
  return apiResponse.success(res, await answerQuestion(companyId, q, todayInSast()));
}

export default withAuth(withErrorHandler(handler as any));
