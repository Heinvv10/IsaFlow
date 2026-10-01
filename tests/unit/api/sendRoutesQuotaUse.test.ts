/**
 * R-175 review round 3: the send routes, driven through their real services
 * down to the real email sender. Only the mail transport, the database and the
 * outside services (Signum, GoTrue-backed invitations) are stubbed.
 *
 * Each route must keep its daily unit when the mail server accepted the email
 * and leave it unused, so withAuth gives it back, when it did not. Each must
 * also count an attempt per user before it touches the company's shared bucket,
 * and must not charge that bucket for a malformed request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { sendMail, sqlMock, checkSend, checkAttempts } = vi.hoisted(() => ({
  sendMail: vi.fn(), sqlMock: vi.fn(), checkSend: vi.fn(), checkAttempts: vi.fn(),
}));
vi.mock('nodemailer', () => {
  const createTransport = () => ({ sendMail });
  return { default: { createTransport }, createTransport };
});
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: checkSend, checkRateLimit: checkAttempts }));
vi.mock('fs/promises', () => ({ default: { readFile: vi.fn(async () => '<html>afs</html>') } }));
vi.mock('@/lib/storage/afsStorage', () => ({ afsHtmlPath: () => '/tmp/afs.html' }));
vi.mock('@/modules/accounting/services/afs/signumIntegrationService', () => ({
  sendForSigning: vi.fn(async () => ({ signumDocumentId: 'sig-1', signingTokens: [{ email: 'director@co.test', signingToken: 'tok' }] })),
}));
vi.mock('@/modules/accounting/services/core/userAccessService', () => ({
  listPendingInvitations: vi.fn(),
  cancelInvitation: vi.fn(),
  createInvitation: vi.fn(async () => ({ autoAdded: false, invitation: { id: 'inv-1', token: 'invite-token' } })),
  markInvitationEmailSent: vi.fn(async () => undefined),
  markInvitationEmailFailed: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/ar/portalTokenService', () => ({
  getInvoicePortalToken: vi.fn(async () => 'portal-token'),
  getOrMintInvoicePortalToken: vi.fn(async () => ({ token: 'portal-token' })),
}));

import { als, type RequestContext } from '@/lib/als';
import { apiResponse } from '@/lib/apiResponse';
import dunningSend from '../../../pages/api/accounting/ar/dunning/send';
import companyInvitations from '../../../pages/api/accounting/company-invitations';
import sendForSigningRoute from '../../../pages/api/accounting/afs/[documentId]/send-for-signing';
import invoiceEmail from '../../../pages/api/accounting/invoice-email';

const COMPANY = '11111111-1111-4111-9111-111111111111';
const ID = (n: number) => `22222222-2222-4222-9222-${String(n).padStart(12, '0')}`;
const user = { id: 'u1', email: 'admin@co.test' };

const ROUTES = [
  {
    name: 'dunning', handler: dunningSend as unknown as H, mails: 1,
    ok: { method: 'POST', body: { invoiceId: ID(1), templateId: ID(2) } },
    malformed: { method: 'POST', body: { invoiceId: 'nope' } },
    notOwned: ['FROM customer_invoices ci', 'dunning_templates'],
  },
  {
    name: 'company-invitations', handler: companyInvitations as unknown as H, mails: 1,
    ok: { method: 'POST', body: { email: 'new@co.test', role: 'viewer' }, companyRole: 'owner' },
    malformed: { method: 'POST', body: { role: 'viewer' }, companyRole: 'owner' },
    notOwned: [],
  },
  {
    name: 'afs-signing', handler: sendForSigningRoute as unknown as H, mails: 1,
    ok: { method: 'POST', query: { documentId: ID(3) }, body: { signerContactIds: [ID(4)] } },
    malformed: { method: 'POST', query: { documentId: ID(3) }, body: { signerContactIds: [] } },
    notOwned: ['FROM afs_documents', 'FROM portal_contacts'],
  },
] as const;

/** The stubbed database. A query whose text contains `missing` finds nothing, as for a record of another company. */
function database(missing?: string) {
  return async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (missing && text.includes(missing)) return [];
    if (text.includes('INSERT INTO dunning_sends')) return [{ id: ID(9), message_token: 'tok' }];
    if (text.includes('FROM customer_invoices ci')) {
      return [{ invoice_id: ID(1), invoice_number: 'INV-1', invoice_date: '2026-08-01', due_date: '2026-08-31', total_amount: 100, amount_paid: 0, status: 'sent', customer_name: 'Debtor', customer_email: 'debtor@co.test', company_name: 'Co' }];
    }
    if (text.includes('FROM customer_invoices')) return [{ ok: 1 }];
    if (text.includes('dunning_templates')) return [{ id: ID(2), subject_template: 'Overdue {{invoice_number}}', body_template: 'Pay at {{portal_link}}' }];
    if (text.includes('INSERT INTO captured_documents')) return [{ id: ID(8) }];
    if (text.includes('FROM afs_documents')) return [{ id: ID(3), status: 'partner_review', signing_requested_at: null }];
    if (text.includes('FROM portal_contacts')) return [{ id: ID(4), name: 'Dee', email: 'director@co.test', role: 'director' }];
    if (text.includes('FROM companies')) return [{ name: 'Co' }];
    return [];
  };
}

function res(): NextApiResponse {
  const r = { statusCode: 200, status(c: number) { r.statusCode = c; return r; }, json() { return r; }, setHeader() { return r; }, end() { return r; } };
  return r as unknown as NextApiResponse;
}

/** Runs the route as a request that charged `charged` daily send units; returns how many it used. */
async function unitsUsed(route: (typeof ROUTES)[number], shape: 'ok' | 'malformed'): Promise<number> {
  const ctx: RequestContext = {
    client: {} as RequestContext['client'], userId: user.id, claims: {}, afterCommit: [],
    quotaCharges: [{ kind: 'send', key: `send:${route.name}:co:${COMPANY}:day`, charged: 1, used: 0, windowStart: null }],
  };
  await als.run(ctx, async () => {
    await route.handler({ query: {}, ...route[shape], companyId: COMPANY, user } as unknown as NextApiRequest, res());
  });
  return ctx.quotaCharges![0]!.used;
}

describe.each(ROUTES)('$name — daily send unit and abuse limit (R-175)', (route) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SMTP_HOST', 'mail.test');
    vi.stubEnv('SMTP_USER', 'u');
    vi.stubEnv('SMTP_PASS', 'p');
    vi.stubEnv('PUBLIC_APP_URL', 'https://app.test');
    checkSend.mockResolvedValue(true);
    checkAttempts.mockResolvedValue(true);
    sendMail.mockResolvedValue({ messageId: 'mid' });
    sqlMock.mockImplementation(database());
  });
  afterEach(() => vi.unstubAllEnvs());

  it('keeps its unit after the mail server accepted the email', async () => {
    expect(await unitsUsed(route, 'ok')).toBe(route.mails);
    expect(sendMail).toHaveBeenCalledTimes(route.mails);
    expect(checkSend.mock.calls[0]![2]).toBe(route.name);
    expect(checkSend.mock.calls[0]![3]).toMatchObject({ refundUnused: true });
  });

  it('leaves its unit unused when the mail server is down', async () => {
    sendMail.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await unitsUsed(route, 'ok')).toBe(0);
    expect(sendMail).toHaveBeenCalledTimes(route.mails);
  });

  it('leaves its unit unused when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');

    expect(await unitsUsed(route, 'ok')).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

// company-invitations validates before it charges and is admin-only; it has no
// per-user limiter. invoice-email is here for its limiter only: its send path
// is covered by the email sender's own test.
const LIMITED = [
  ...ROUTES.filter((r) => r.name !== 'company-invitations'),
  {
    name: 'invoice-email', handler: invoiceEmail as unknown as H, mails: 0,
    ok: { method: 'POST', body: { invoiceId: ID(1), recipientEmail: 'a@b.co' } },
    malformed: { method: 'POST', body: { invoiceId: ID(1), recipientEmail: 'not-an-email' } },
    notOwned: ['FROM customer_invoices'],
  },
] as unknown as typeof ROUTES;

describe.each(LIMITED)('$name — abuse limit before the shared bucket (R-175)', (route) => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkSend.mockResolvedValue(true);
    checkAttempts.mockResolvedValue(true);
    sqlMock.mockImplementation(database());
  });

  // Review round 4: naming a record the company does not own sends nothing,
  // so it must not spend the allowance every colleague shares.
  it.each(route.notOwned)('a request refused because nothing matches "%s" leaves the company bucket untouched', async (missing) => {
    sqlMock.mockImplementation(database(missing));
    await unitsUsed(route, 'ok');

    expect(sqlMock).toHaveBeenCalled();
    expect(checkAttempts).toHaveBeenCalledTimes(1);
    expect(checkSend).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('charges the company bucket once every check has passed', async () => {
    checkSend.mockResolvedValue(false);
    await unitsUsed(route, 'ok');

    expect(checkSend).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('counts the attempt against the user, and a malformed request never reaches the company bucket', async () => {
    await unitsUsed(route, 'malformed');

    // Keyed by company and user: a bureau user has one allowance per client.
    expect(checkAttempts.mock.calls).toEqual([[`${route.name}:attempts:${COMPANY}:u1`, { max: 30, windowSecs: 900 }]]);
    expect(checkSend).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('refuses a user over the abuse limit before the company bucket', async () => {
    checkAttempts.mockResolvedValue(false);
    const tooMany = vi.spyOn(apiResponse, 'tooManyRequests');
    await unitsUsed(route, 'ok');

    expect(tooMany).toHaveBeenCalledTimes(1);
    expect(checkSend).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

it('invoice-email answers 400, before any query or charge, for an invoice id that is not a UUID (R-175)', async () => {
  vi.clearAllMocks();
  checkAttempts.mockResolvedValue(true);
  checkSend.mockResolvedValue(true);
  const badRequest = vi.spyOn(apiResponse, 'badRequest');

  await (invoiceEmail as unknown as H)(
    { method: 'POST', query: {}, body: { invoiceId: "x'::text", recipientEmail: 'a@b.co' }, companyId: COMPANY, user } as unknown as NextApiRequest,
    res(),
  );

  expect(badRequest).toHaveBeenCalledWith(expect.anything(), 'invoiceId must be a UUID');
  expect(sqlMock).not.toHaveBeenCalled();
  expect(checkSend).not.toHaveBeenCalled();
});
