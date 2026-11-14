/**
 * "Ask IsaFlow" (wave 5 M11): GET /api/accounting/ask?q=<question>
 * A fixed set of question patterns answered by the same read-only services the MCP tools wrap. No model, nothing
 * is written. An unrecognised question answers `understood: false` with example questions.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { markFlowNoOp, withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { todayInSast } from '@/lib/saDateParser';
import { resolveProvider } from '@/modules/accounting/services/ask/askProvider';
import { meteredOperation, parseQuestion } from '@/modules/accounting/services/ask/askIntents';
import { getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { periodIsHonoured } from '@/modules/accounting/services/ask/askPeriod';
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
  const answer = await answerQuestion(companyId, q, todayInSast());
  // A metered intent is charged up front; one that returned no figure (a refused period, a missing run) did no billable work.
  if (answer.figure === null) markFlowNoOp(req);
  return apiResponse.success(res, answer);
}

const pnl = withFlowMeter('report.pnl', getFlowCost('report.pnl'))(handler);
const bs = withFlowMeter('report.bs', getFlowCost('report.bs'))(handler);

/**
 * Charges like the report the figure comes from, and only for a question that is understood and unambiguous: an
 * unrecognised or ambiguous one, a bad request and free-text mode never reach a meter.
 */
async function route(req: NextApiRequest, res: NextApiResponse) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const parsed = req.method === 'GET' && q && q.length <= MAX_QUESTION && req.query.mode !== 'free' ? parseQuestion(q) : null;
  const intent = parsed?.kind === 'intent' ? parsed.intent : null;
  const op = intent ? meteredOperation(intent.id) : null;
  // A window we would refuse is decided before any debit: it costs nothing, and a short wallet never sees a 402 for it.
  if (intent && op && !periodIsHonoured(intent.id, intent.period, todayInSast())) return handler(req, res);
  // A financial year the registry does not hold is refused: decided here, before any debit, like the other refused windows.
  if (intent && op && intent.period?.kind === 'fy' && !(await getFiscalYear((req as CompanyAuthedRequest).companyId, intent.period.year))) return handler(req, res);
  return (op === 'report.pnl' ? pnl : op === 'report.bs' ? bs : handler)(req, res);
}

export default withAuth(withErrorHandler(route as any));
