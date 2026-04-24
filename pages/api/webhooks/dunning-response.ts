/**
 * POST /api/webhooks/dunning-response
 * Body: { messageToken, action, note? }
 *
 * Records a customer's response to a dunning email. The message_token is a
 * per-send UUID embedded in the outbound email as `[ref:TOKEN]`; inbound
 * parsers (mail processors, Zapier, etc.) forward responses here.
 *
 * Security model: the token itself is unguessable (UUIDv4, logged only to
 * our DB + the outbound email). An optional X-Webhook-Secret header adds
 * a second layer when DUNNING_WEBHOOK_SECRET is configured — required in
 * production, optional in dev for manual testing.
 *
 * PRD-06 Phase 5.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { recordResponse } from '@/modules/accounting/services/ar/dunningAdmin';
import type { ResponseAction } from '@/modules/accounting/services/ar/dunningService';

const VALID_ACTIONS: ResponseAction[] = ['paid', 'promised', 'disputed', 'silent'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  // Pentest L18: fail-closed secret verification. Previously, a missing env
  // var silently skipped the check — webhook was world-writable in dev or
  // any environment where the secret wasn't configured.
  const expectedSecret = process.env.DUNNING_WEBHOOK_SECRET;
  if (!expectedSecret) {
    log.error('DUNNING_WEBHOOK_SECRET not set — rejecting webhook', undefined, 'dunning-webhook');
    res.status(503).json({ success: false, error: { code: 'WEBHOOK_MISCONFIGURED', message: 'Webhook misconfigured' } });
    return;
  }
  if (req.headers['x-webhook-secret'] !== expectedSecret) {
    log.warn('dunning-response unauthorized', { ip: req.socket.remoteAddress }, 'dunning-webhook');
    apiResponse.unauthorized(res);
    return;
  }

  const body = req.body ?? {};
  const messageToken = typeof body.messageToken === 'string' ? body.messageToken.trim() : '';
  const actionRaw = typeof body.action === 'string' ? body.action : '';
  const note = typeof body.note === 'string' && body.note.trim().length > 0
    ? body.note.trim().slice(0, 1000)
    : null;

  if (!UUID_RE.test(messageToken)) {
    apiResponse.badRequest(res, 'messageToken must be a UUID');
    return;
  }
  if (!(VALID_ACTIONS as string[]).includes(actionRaw)) {
    apiResponse.badRequest(res, `action must be one of ${VALID_ACTIONS.join(', ')}`);
    return;
  }

  const result = await recordResponse(messageToken, actionRaw as ResponseAction, note);
  if (!result.updated) {
    apiResponse.notFound(res, 'Dunning send', messageToken);
    return;
  }
  log.info('Dunning response recorded', {
    sendId: result.sendId, action: actionRaw,
  }, 'dunning-webhook');
  apiResponse.success(res, { updated: true, sendId: result.sendId });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
