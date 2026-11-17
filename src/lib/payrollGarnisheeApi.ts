/**
 * The HTTP side shared by the garnishee-order routes (wave 6 GA, spec rule 14). An order makes payroll deduct money from
 * an employee's pay for a creditor, so a write is taken only:
 *   - by the payroll-detail roles (owner, admin, manager: withPayrollDetailAccess on the route);
 *   - from a person signed in as themselves: a token channel (no session id) is 403 AGENT_FORBIDDEN;
 *   - never under Login-as (403 IMPERSONATION_FORBIDDEN).
 * All judged before the service reads or writes anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from '@/lib/auth';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { getClientIp } from '@/lib/rateLimit';
import { GARNISHEE_KINDS, GarnisheeOrderRefusal } from '@/modules/accounting/services/payroll/payrollGarnishee';
import type { GarnisheeActor } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor of a garnishee-order write, or null once a refusal has been sent. */
export async function garnisheeWriter(req: NextApiRequest, res: NextApiResponse): Promise<GarnisheeActor | null> {
  const { user } = req as CompanyAuthedRequest;
  if ((await currentSessionActor()) === 'unknown') {
    apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can do this; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
    return null;
  }
  try {
    await assertNotImpersonating();
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return null;
    throw err;
  }
  const sessionId = typeof user.claims.session_id === 'string' ? user.claims.session_id : null;
  const agent = req.headers['user-agent'];
  return { userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: typeof agent === 'string' ? agent : undefined, sessionId };
}

const CODE: Record<number, ErrorCode> = { 400: ErrorCode.BAD_REQUEST, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT };

/** Answers a GarnisheeOrderRefusal (raised before any write); false for anything else. */
export function respondIfGarnisheeRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof GarnisheeOrderRefusal)) return false;
  apiResponse.error(res, CODE[err.status]!, err.message, { reason: err.reason });
  return true;
}

const money = z.number().finite();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD');

/** POST body for a new order: every key named, nothing else accepted (rule 18: strict parsers). */
export const CreateOrderBody = z.object({
  kind: z.enum(GARNISHEE_KINDS),
  reference: z.string().max(200),
  creditorName: z.string().max(400),
  instalment: money,
  totalDebt: money.nullable(),
  startDate: date,
  endDate: date.nullable(),
  priority: z.number().int(),
}).strict();

/** POST body to end an order. */
export const EndOrderBody = z.object({ endDate: date, reason: z.string().max(1000) }).strict();
