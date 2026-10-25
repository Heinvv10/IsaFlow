/**
 * S-07e (migration 945): no app role writes subscription_mandates or reads the
 * Paystack codes on it. mandate/create inserts, mandate/revoke reads the
 * subscription code + email token and updates, both on the migration_admin pool
 * and both for the company withAuth verified, never one read from the body.
 * Only withAuth, withErrorHandler, the DB pools and Paystack are faked; withRole
 * and withCsrf are the real ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  script: [] as unknown[][],
  failLabel: null as string | null,
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminSqlTx: async (label: string, fn: (tx: unknown) => Promise<unknown>) => {
    if (h.failLabel === label) throw new Error('admin pool down');
    return fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.admin.push({ label, text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
      return h.script.shift() ?? [];
    });
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (x: unknown) => x }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (x: unknown) => x }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: vi.fn(),
  disableSubscription: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { initializeTransaction, disableSubscription } from '@/modules/billing/services/paystackClient';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf';
import create from '../../../pages/api/billing/paystack/mandate/create';
import revoke from '../../../pages/api/billing/paystack/mandate/revoke';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'c'.repeat(64);

function makeRes() {
  const res = {
    statusCode: 200, body: undefined as { data?: Record<string, unknown>; error?: { message?: string } } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  return res;
}
async function call(route: unknown, role: string | null, body: unknown) {
  const res = makeRes();
  const req = {
    method: 'POST', query: {}, body,
    headers: { [CSRF_HEADER]: TOKEN }, cookies: { [CSRF_COOKIE]: TOKEN },
    companyId: COMPANY, companyRole: role, user: { id: 'u-1', email: 'u@example.com' },
  } as unknown as NextApiRequest;
  await (route as H)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  h.admin.length = 0;
  h.script.length = 0;
  h.failLabel = null;
  vi.clearAllMocks();
  vi.mocked(sql).mockReset().mockImplementation((async () => []) as never);
});

describe('POST mandate/create', () => {
  it('inserts the pending mandate on the migration_admin pool for the verified company and user', async () => {
    h.script.push([{ id: 'm-1' }]);
    vi.mocked(initializeTransaction).mockResolvedValueOnce({
      reference: 'r', accessCode: 'a', authorizationUrl: 'https://pay.example/x',
    } as never);

    const res = await call(create, 'owner', { maxAmountCents: 500000 });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.label).toBe('mandate_create');
    expect(h.admin[0]!.text).toMatch(/^INSERT INTO subscription_mandates/);
    expect(h.admin[0]!.values).toEqual([COMPANY, 500000, 'u-1']);
    // The app pool never writes the mandates table.
    const appTexts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(appTexts.some((t) => /INSERT INTO subscription_mandates/.test(t))).toBe(false);
  });

  it('refuses a company id in the body: the company is the verified request\'s alone', async () => {
    const res = await call(create, 'owner', { maxAmountCents: 500000, company_id: OTHER });
    expect(res.statusCode).toBe(400);
    expect(h.admin).toHaveLength(0);
  });

  it('refuses a role below admin before any write', async () => {
    const res = await call(create, 'viewer', { maxAmountCents: 500000 });
    expect(res.statusCode).toBe(403);
    expect(h.admin).toHaveLength(0);
  });

  it('marks the committed mandate failed, for the same company, when Paystack cannot be reached', async () => {
    // The row COMMITted on its own connection, so the request's >= 500 rollback does not remove it.
    h.script.push([{ id: 'm-1' }]);
    vi.mocked(initializeTransaction).mockRejectedValueOnce(new Error('paystack down'));

    const res = await call(create, 'admin', { maxAmountCents: 500000 });

    expect(res.statusCode).toBe(500);
    expect(h.admin.map((a) => a.label)).toEqual(['mandate_create', 'mandate_create_failed']);
    expect(h.admin[1]!.text).toMatch(/SET status = 'failed'[\s\S]*status = 'pending'/);
    expect(h.admin[1]!.values).toEqual(['m-1', COMPANY]);
  });

  it('still answers 500 when marking the abandoned mandate fails too', async () => {
    h.script.push([{ id: 'm-1' }]);
    vi.mocked(initializeTransaction).mockRejectedValueOnce(new Error('paystack down'));
    h.failLabel = 'mandate_create_failed';

    const res = await call(create, 'admin', { maxAmountCents: 500000 });

    expect(res.statusCode).toBe(500);
  });
});

describe('POST mandate/revoke', () => {
  it('reads the Paystack codes on the migration_admin pool, disables the subscription, then revokes scoped to the company', async () => {
    h.script.push([{ id: 'm-1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok' }], []);

    const res = await call(revoke, 'owner', { reason: 'closing' });

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(h.admin.map((a) => a.label)).toEqual(['mandate_revoke_read', 'mandate_revoke']);
    expect(h.admin[0]!.text).toMatch(/paystack_subscription_code, paystack_email_token/);
    expect(h.admin[0]!.values).toEqual([COMPANY]);
    expect(disableSubscription).toHaveBeenCalledWith({ subscriptionCode: 'SUB_1', emailToken: 'tok' });
    expect(h.admin[1]!.text).toMatch(/SET status = 'revoked'/);
    expect(h.admin[1]!.values).toEqual(['closing', 'm-1', COMPANY]);
    // No app-pool statement reads the codes.
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('answers 404 and writes nothing when the company has no active mandate', async () => {
    h.script.push([]);
    const res = await call(revoke, 'admin', {});
    expect(res.statusCode).toBe(404);
    expect(h.admin.map((a) => a.label)).toEqual(['mandate_revoke_read']);
    expect(disableSubscription).not.toHaveBeenCalled();
  });

  it('still revokes locally when Paystack refuses to disable the subscription', async () => {
    h.script.push([{ id: 'm-1', paystack_subscription_code: 'SUB_1', paystack_email_token: 'tok' }], []);
    vi.mocked(disableSubscription).mockRejectedValueOnce(new Error('paystack 500'));

    const res = await call(revoke, 'admin', {});

    expect(res.statusCode).toBe(200);
    expect(h.admin.map((a) => a.label)).toEqual(['mandate_revoke_read', 'mandate_revoke']);
  });

  it('refuses a role below admin before any read', async () => {
    const res = await call(revoke, 'manager', {});
    expect(res.statusCode).toBe(403);
    expect(h.admin).toHaveLength(0);
  });
});
