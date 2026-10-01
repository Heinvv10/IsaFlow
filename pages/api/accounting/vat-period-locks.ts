/**
 * VAT period locks API
 *
 * GET  /api/accounting/vat-period-locks
 *        Every lock for the company INCLUDING unlocked history; `active` says
 *        which still lock.
 * POST /api/accounting/vat-period-locks
 *        { action: 'lock', periodStart, periodEnd, notes?, force?, overrideReason? }
 *          Records the filed return (the same figures lock_vat_period records,
 *          from computeVatLockFigures). Refuses a period failing SARS's 15%
 *          check unless force:true (unrelated to overrideReason — see below).
 *          Idempotent on the period.
 *          Separately, refuses when getVatExceptions reports blocking
 *          exceptions, UNLESS the caller is owner/admin and supplies a
 *          non-empty overrideReason — recorded (migration 704) and never
 *          consulted by the ISV filing gate, which stays absolute.
 *        { action: 'unlock', lockId, reason }
 *          OWNER/ADMIN ONLY. Stamps who/when/why on the lock; the row stays as
 *          history and the period accepts VAT postings again. There is no MCP
 *          equivalent, deliberately.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withSavepoint } from '@/lib/neon';
import {
  withAuth, withRole, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  VatLockTimeoutError, VatPeriodLockRefusal, VatPeriodUnlockRefusal, getVatPeriodLock, listVatPeriodLocks, lockVatPeriod, unlockVatPeriod,
} from '@/modules/accounting/services/reports/vatPeriodLockService';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import {
  assertVatGateClear, VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('lock'),
    periodStart: ISO_DATE,
    periodEnd: ISO_DATE,
    notes: z.string().max(2000).optional(),
    force: z.boolean().optional(),
    overrideReason: z.string().trim().min(1).max(2000).optional(),
  }),
  z.object({
    action: z.literal('unlock'),
    lockId: UUID,
    reason: z.string().trim().min(1, 'A reason is required to unlock a VAT period').max(2000),
  }),
]);

type LockBody = Extract<z.infer<typeof BodySchema>, { action: 'lock' }>;
type UnlockBody = Extract<z.infer<typeof BodySchema>, { action: 'unlock' }>;

async function lock(req: NextApiRequest, res: NextApiResponse, body: LockBody) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (body.periodEnd < body.periodStart) {
    return apiResponse.badRequest(res, 'periodEnd must not be before periodStart');
  }
  // Both refusals below are raised before the INSERT (bounds, lock timeout),
  // so their 4xx commits nothing.
  try {
    return await lockChecked(req, res, body, companyId, userId);
  } catch (err) {
    if (err instanceof VatGateOverrideForbiddenError) return apiResponse.forbidden(res, err.message);
    if (err instanceof VatGateBlockedError) return apiResponse.badRequest(res, err.message, { counts: err.counts });
    if (err instanceof VatPeriodLockRefusal) return apiResponse.badRequest(res, err.message);
    if (err instanceof VatLockTimeoutError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

async function lockChecked(
  req: NextApiRequest, res: NextApiResponse, body: LockBody, companyId: string, userId: string,
) {
  const { figures, report } = await computeVatLockFigures(companyId, body.periodStart, body.periodEnd);
  const existing = await getVatPeriodLock(companyId, body.periodStart, body.periodEnd);
  if (!existing && report.rateCheck.ties === false && body.force !== true) {
    return apiResponse.badRequest(res,
      `This period fails SARS's 15% check: box 1 is out by ${report.rateCheck.outputVariance} and input tax is `
      + `over-claimed by ${report.rateCheck.inputVariance} (summed per journal). Correct it, or lock with force to record it as filed.`);
  }
  // Blocking VAT exceptions — separate from the rateCheck/force refusal above.
  // Runs before lockVatPeriod's write; only an owner/admin with a reason may
  // proceed with exceptions outstanding. Both the override record and the
  // lock write run in ONE savepoint: if lockVatPeriod then refuses or fails,
  // the override row rolls back with it — an override must never stand for a
  // lock that never actually happened.
  const companyRole = (req as CompanyAuthedRequest).companyRole;
  const { gate, result } = await withSavepoint('vat_gate_lock', async () => {
    const g = await assertVatGateClear(
      companyId, body.periodStart, body.periodEnd, 'vat_period_lock', null,
      { userId, role: companyRole }, body.overrideReason,
    );
    const r = await lockVatPeriod(
      companyId, body.periodStart, body.periodEnd, figures, { userId, actorType: 'human' }, body.notes,
    );
    return { gate: g, result: r };
  });
  log.info('VAT period lock via API', { companyId, lockId: result.lock.id, created: result.created }, 'accounting-api');
  return apiResponse.success(res, {
    lock: result.lock, created: result.created, rateCheck: report.rateCheck,
    exceptionsOverridden: gate.overridden,
  });
}

async function unlock(req: NextApiRequest, res: NextApiResponse, body: UnlockBody) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    const unlocked = await unlockVatPeriod(companyId, body.lockId, userId, body.reason);
    log.info('VAT period unlock via API', { companyId, lockId: unlocked.id }, 'accounting-api');
    return apiResponse.success(res, { lock: unlocked });
  } catch (err) {
    // Refused before any write: blank reason, not this company's lock, or already unlocked.
    if (err instanceof VatPeriodUnlockRefusal) return apiResponse.badRequest(res, err.message);
    if (err instanceof VatLockTimeoutError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method === 'GET') {
    return apiResponse.success(res, { locks: await listVatPeriodLocks(companyId, 200) });
  }
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
  }
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const body = parsed.data;
  if (body.action === 'lock') return lock(req, res, body);
  // Unlocking reopens a FILED return to change: owner/admin only, gated here.
  return withRole('admin')((r: NextApiRequest, s: NextApiResponse) => unlock(r, s, body))(req, res);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
