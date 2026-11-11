/** A ReturnRefusal's code and details reach the client in error.details, on a 409 and on a 400 (wave 5 L2). */
import { describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { respondReturnRefusal } from '@/modules/accounting/services/returns/respondRefusal';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

function capture(): { res: NextApiResponse; out: () => { status: number; body: { error: { message: string; details?: Record<string, unknown> } } } } {
  let status = 0; let body: unknown = null;
  const res = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; }, setHeader() { return this; } };
  return { res: res as unknown as NextApiResponse, out: () => ({ status, body: body as never }) };
}

describe('respondReturnRefusal', () => {
  it('409: code and the next-step data in details', () => {
    const c = capture();
    respondReturnRefusal(c.res, new ReturnRefusal(409, 'filed elsewhere', 'LEGACY_SUBMISSION_EXISTS', { legacySubmissionIds: ['a', 'b'] }));
    expect(c.out().status).toBe(409);
    expect(c.out().body.error.details).toEqual({ code: 'LEGACY_SUBMISSION_EXISTS', legacySubmissionIds: ['a', 'b'] });
  });

  it('400: the code reaches the client too', () => {
    const c = capture();
    respondReturnRefusal(c.res, new ReturnRefusal(400, 'fails the 15% check', 'RATE_CHECK_FAILED'));
    expect(c.out().status).toBe(400);
    expect(c.out().body.error).toMatchObject({ message: 'fails the 15% check', details: { code: 'RATE_CHECK_FAILED' } });
  });

  it('no code: no details', () => {
    const c = capture();
    respondReturnRefusal(c.res, new ReturnRefusal(400, 'plain'));
    expect(c.out().body.error.details).toBeUndefined();
  });
});
