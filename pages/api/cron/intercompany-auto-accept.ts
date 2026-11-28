/**
 * Cron endpoint - intercompany auto-accept (P2).
 *
 * Accepts, as the RECEIVER, the invoice / credit-note messages that a receiving company asked to have accepted automatically
 * on an active group connection: a DRAFT supplier invoice / credit note is created in the receiver's own books (nothing is
 * approved), the message is marked accepted, the documents are linked. Each message runs in its own transaction opened as a
 * write-role user of the receiver (see autoAcceptWorker.ts); a message that cannot be accepted is marked failed with a fixed
 * sentence. A failure of one never stops the rest. The answer is 500 when any message failed or keeps deferring, so the timer's curl --fail reports it.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var (timing-safe compare).
 * System-level endpoint - no withAuth; runs on the service pool's login (isaflow_service), whose only tenant reach is the
 * definer queue and `SET LOCAL ROLE app_user` into one receiver at a time.
 * Triggered by scripts/isaflow-intercompany-auto-accept.timer (installing it on the server is an ops step).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runAutoAccept } from '@/modules/accounting/services/intercompany/autoAcceptWorker';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-intercompany-auto-accept');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-intercompany-auto-accept');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: intercompany auto-accept', {}, 'cron-intercompany-auto-accept');
  const result = await runAutoAccept();
  // A message that failed, that keeps deferring (a persistent fault), or that used all 8 attempts (the queue gave up on it; a person must review it), is a 500, so the timer's curl --fail reports it.
  if (result.failed > 0 || result.stuck > 0) {
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR,
      `Intercompany auto-accept: ${result.failed} of ${result.considered} messages failed, ${result.stuck} stuck (${result.exhausted} out of attempts)`, result);
  }
  return apiResponse.success(res, result);
}

// NOTE: no withAuth - system-level cron endpoint
export default withErrorHandler(handler as never);
