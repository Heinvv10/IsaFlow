/**
 * R-175 /review: send-for-signing's bounded work is the Signum document, not
 * only the signer emails. With SMTP down it used to create the document, send
 * nothing, answer 200 and get its daily unit back.
 *
 * The unit is used once Signum has created the document, or when the Signum
 * call times out (it may have). A Signum refusal, or a failure before the call
 * was sent, did no work and uses nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: vi.fn(async () => true), checkRateLimit: vi.fn(async () => true) }));
vi.mock('fs/promises', () => ({ default: { access: vi.fn(async () => undefined), readFile: vi.fn(async () => '<html>afs</html>') } }));
vi.mock('@/lib/storage/afsStorage', () => ({ afsHtmlPath: () => '/tmp/afs.html' }));
const { sendForSigning, notify } = vi.hoisted(() => ({ sendForSigning: vi.fn(), notify: vi.fn() }));
vi.mock('@/modules/accounting/services/afs/signumIntegrationService', () => ({ sendForSigning }));
// Every signer email fails: the notifier sends nothing (it logs and swallows its own errors).
vi.mock('@/modules/accounting/services/afs/portalNotificationService', () => ({ notifySigningRequested: notify }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('FROM afs_documents')) return [{ id: 'd', status: 'partner_review', signing_requested_at: null }];
    if (text.includes('FROM portal_contacts')) return [{ id: ID, name: 'Dee', email: 'director@co.test', role: 'director' }];
    if (text.includes('FROM companies')) return [{ name: 'Co' }];
    return [];
  }),
}));

import { als, type RequestContext } from '@/lib/als';
import route from '../../../pages/api/accounting/afs/[documentId]/send-for-signing';

const ID = '44444444-4444-4444-9444-444444444444';
const DOC = '33333333-3333-4333-9333-333333333333';

/** Runs the route as a request that charged one daily send unit; returns how much was used and whether it threw. */
async function run(): Promise<{ used: number; threw: boolean }> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [],
    quotaCharges: [{ kind: 'send', key: 'send:afs-signing:co:c:day', charged: 1, used: 0, windowStart: null }],
  };
  const res = { status() { return res; }, json() { return res; } } as unknown as NextApiResponse;
  let threw = false;
  await als.run(ctx, async () => {
    await (route as unknown as H)({ method: 'POST', query: { documentId: DOC }, body: { signerContactIds: [ID] }, companyId: 'c', user: { id: 'u1' } } as unknown as NextApiRequest, res);
  }).catch(() => { threw = true; });
  return { used: ctx.quotaCharges![0]!.used, threw };
}

describe('send-for-signing — the Signum document spends the unit (R-175)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notify.mockResolvedValue(undefined);
    sendForSigning.mockResolvedValue({ signumDocumentId: 'sig-1', signingTokens: [{ email: 'director@co.test', signingToken: 't' }] });
  });

  it('Signum created the document and every email failed: the unit stays spent', async () => {
    expect(await run()).toEqual({ used: 1, threw: false });
    expect(sendForSigning).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('Signum refused (it answered with an error status): nothing was done, the unit comes back', async () => {
    sendForSigning.mockRejectedValue(Object.assign(new Error('Signum create failed: 503 busy'), { status: 503 }));
    expect(await run()).toEqual({ used: 0, threw: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('Signum could not be reached: the unit comes back', async () => {
    sendForSigning.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await run()).toEqual({ used: 0, threw: true });
  });

  it('the Signum call timed out: it may have created the document, so the unit is spent', async () => {
    sendForSigning.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await run()).toEqual({ used: 1, threw: true });
  });
});
