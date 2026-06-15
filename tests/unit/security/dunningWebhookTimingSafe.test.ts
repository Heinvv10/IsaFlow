/**
 * Pentest re-run H11 — dunning webhooks compared the X-Webhook-Secret with `!==`.
 *
 * A plain `!==` on a secret leaks it via response timing. Both dunning webhook
 * endpoints now use timingSafeEqualStr (constant-time). These tests assert the
 * timing-safe comparator is used, a non-matching secret is rejected (401), an
 * array/absent header is rejected without calling the comparator unsafely, and a
 * matching secret proceeds.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { timingSafeMock } = vi.hoisted(() => ({ timingSafeMock: vi.fn() }));
vi.mock('@/lib/timingSafe', () => ({ timingSafeEqualStr: timingSafeMock }));

vi.mock('@/modules/accounting/services/ar/dunningAdmin', () => ({
  recordResponse: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/modules/accounting/services/ar/dunningInboundParseService', () => ({
  processInboundEmail: vi.fn().mockResolvedValue({ matched: false }),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), unauthorized: vi.fn(),
    methodNotAllowed: vi.fn(), notFound: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { recordResponse } from '@/modules/accounting/services/ar/dunningAdmin';
import { processInboundEmail } from '@/modules/accounting/services/ar/dunningInboundParseService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import responseHandler from '../../../pages/api/webhooks/dunning-response';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import inboundHandler from '../../../pages/api/webhooks/dunning-inbound-email';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const SECRET = 'super-secret-value';
const OLD_ENV = process.env.DUNNING_WEBHOOK_SECRET;
process.env.DUNNING_WEBHOOK_SECRET = SECRET;
afterAll(() => { process.env.DUNNING_WEBHOOK_SECRET = OLD_ENV; });

function makeRes(): NextApiResponse {
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnValue({ json }), json } as unknown as NextApiResponse;
  return res;
}
function makeReq(secretHeader: string | string[] | undefined): NextApiRequest {
  return {
    method: 'POST',
    headers: secretHeader === undefined ? {} : { 'x-webhook-secret': secretHeader },
    socket: { remoteAddress: '1.2.3.4' },
    body: { messageToken: '11111111-1111-4111-9111-111111111111', action: 'paid', from: 'a@b.com' },
  } as unknown as NextApiRequest;
}

const CASES: Array<[string, Handler, () => unknown]> = [
  ['dunning-response', responseHandler as Handler, () => recordResponse],
  ['dunning-inbound-email', inboundHandler as Handler, () => processInboundEmail],
];

describe('dunning webhooks H11 — constant-time secret comparison', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CASES)('%s uses timingSafeEqualStr and rejects a wrong secret (401)', async (_n, handler, downstream) => {
    timingSafeMock.mockReturnValue(false);
    await handler(makeReq('wrong'), makeRes());
    expect(timingSafeMock).toHaveBeenCalledWith('wrong', SECRET);
    expect(apiResponse.unauthorized).toHaveBeenCalledTimes(1);
    expect((downstream() as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it.each(CASES)('%s rejects an array-valued header without calling the comparator', async (_n, handler) => {
    timingSafeMock.mockReturnValue(true); // even if it would "match", a non-string is rejected
    await handler(makeReq(['a', 'b']), makeRes());
    expect(timingSafeMock).not.toHaveBeenCalled();
    expect(apiResponse.unauthorized).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('%s proceeds when the secret matches', async (_n, handler, downstream) => {
    timingSafeMock.mockReturnValue(true);
    await handler(makeReq(SECRET), makeRes());
    expect(apiResponse.unauthorized).not.toHaveBeenCalled();
    expect((downstream() as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
