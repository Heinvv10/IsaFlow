/**
 * Pentest re-run H9 — email-sending endpoints had no send rate limit.
 *
 * invoice-email (real SMTP per call) and company-invitations (invite email to an arbitrary
 * address) were protected only by auth/CSRF/write-access — a logged-in user could loop them
 * into a spam cannon. Both now gate on checkSendRateLimit. These tests assert each returns
 * 429 and does NOT send when the limiter is over.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
  withWriteAccess: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

const { checkSendRateLimitMock } = vi.hoisted(() => ({ checkSendRateLimitMock: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({
  checkSendRateLimit: checkSendRateLimitMock,
  checkRateLimit: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}));

vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendInvoiceEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'm1' }),
  sendInviteEmail: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/modules/accounting/services/core/userAccessService', () => ({
  listPendingInvitations: vi.fn(), createInvitation: vi.fn(),
  cancelInvitation: vi.fn(), markInvitationEmailSent: vi.fn(), markInvitationEmailFailed: vi.fn(),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), tooManyRequests: vi.fn(),
    methodNotAllowed: vi.fn(), forbidden: vi.fn(), notFound: vi.fn(), internalError: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { sendInvoiceEmail } from '@/modules/accounting/services/core/emailService';
import { createInvitation } from '@/modules/accounting/services/core/userAccessService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import invoiceEmail from '../../../pages/api/accounting/invoice-email';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import companyInvitations from '../../../pages/api/accounting/company-invitations';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const COMPANY = '11111111-1111-4111-9111-111111111111';
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('email endpoints H9 — checkSendRateLimit gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invoice-email returns 429 and does not send when over the limit', async () => {
    checkSendRateLimitMock.mockResolvedValue(false);
    const req = {
      method: 'POST', query: {},
      body: { invoiceId: 'inv1', recipientEmail: 'a@b.com' },
      companyId: COMPANY, user: { id: 'u1' },
    } as unknown as NextApiRequest;
    await (invoiceEmail as Handler)(req, makeRes());
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('company-invitations returns 429 and does not create/send when over the limit', async () => {
    checkSendRateLimitMock.mockResolvedValue(false);
    const req = {
      method: 'POST', query: {},
      body: { email: 'new@user.com', role: 'viewer' },
      companyId: COMPANY, companyRole: 'admin', user: { id: 'u1', email: 'admin@co.com' },
    } as unknown as NextApiRequest;
    await (companyInvitations as Handler)(req, makeRes());
    expect(apiResponse.tooManyRequests).toHaveBeenCalledTimes(1);
    expect(createInvitation).not.toHaveBeenCalled();
  });
});
