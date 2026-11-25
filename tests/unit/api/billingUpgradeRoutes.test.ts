/**
 * Self-serve upgrade from trial (dark flag `trial_self_serve_upgrade`): GET status, POST start, POST convert.
 * The real withWriteAccess, withCsrf, flag gate, convertTrialInTx and logAuditOrThrow run; withAuth,
 * withErrorHandler, the pools, the flag read and Paystack are faked. The migration_admin tx answers by
 * statement text from a small stateful world, so a conversion really changes what the next call sees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  flag: true,
  world: {} as {
    company: { status: string; trial_ends_at: string | null } | null;
    current: { id: string; status: string; plan_id: string; current_period_end: string; is_paid: boolean } | null;
    mandate: 'none' | 'pending_code' | 'chargeable';
    plan: { code: string; is_active: boolean; monthly_price_cents: number } | null;
  },
}));

const PLAN = '33333333-3333-4333-8333-333333333333';
const OTHER_PLAN = '44444444-4444-4444-8444-444444444444';

function answer(text: string): unknown[] {
  const w = h.world;
  if (/FROM companies c LEFT JOIN LATERAL/.test(text)) {
    if (!w.company) return [];
    return [{
      trial_ends_at: w.company.trial_ends_at, status: w.company.status,
      plan_id: w.current?.plan_id ?? null, is_paid: w.current?.is_paid ?? false,
      has_active_mandate: w.mandate !== 'none', has_chargeable_mandate: w.mandate === 'chargeable',
    }];
  }
  if (/FROM companies/.test(text) && /FOR UPDATE/.test(text)) {
    return w.company ? [{ status: w.company.status, had_trial: w.company.trial_ends_at !== null }] : [];
  }
  if (/FROM plans WHERE id/.test(text)) return w.plan ? [w.plan] : [];
  if (/FROM subscriptions s JOIN plans p/.test(text)) return w.current ? [w.current] : [];
  if (/status = 'paused' LIMIT 1/.test(text)) return [];
  if (/paystack_authorization_code IS NOT NULL/.test(text)) return w.mandate === 'chargeable' ? [{ x: 1 }] : [];
  if (/FROM subscription_mandates/.test(text)) return w.mandate !== 'none' ? [{ x: 1 }] : [];
  if (/^INSERT INTO subscription_mandates/.test(text)) return [{ id: 'm-1' }];
  if (/^UPDATE subscriptions SET plan_id/.test(text)) {
    w.current = { id: w.current!.id, status: 'active', plan_id: PLAN, current_period_end: '2026-12-24T00:00:00.000Z', is_paid: true };
    return [{ id: w.current.id, current_period_end: w.current.current_period_end }];
  }
  return [];
}

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    if (/FROM plans WHERE id/.test(text)) return h.world.plan ? [{ id: PLAN, ...h.world.plan }] : [];
    return [];
  }), { unsafe: vi.fn() });
  return { sql: sqlFn, withSavepoint: async (_n: string, cb: () => unknown) => cb() };
});
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminSqlTx: async (label: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      h.admin.push({ label, text, values });
      return answer(text);
    }),
}));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => h.flag) }));
vi.mock('@/modules/admin/services/planService', () => ({
  listPlans: vi.fn(async () => [
    { id: 'p-trial', code: 'trial', name: 'Trial', description: null, monthly_price_cents: 0, currency: 'ZAR' },
    { id: PLAN, code: 'starter', name: 'Starter', description: 'd', monthly_price_cents: 12300, currency: 'ZAR' },
    { id: 'p-payg', code: 'payg', name: 'PAYG', description: null, monthly_price_cents: 0, currency: 'ZAR' },
  ]),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (x: unknown) => x }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (x: unknown) => x }));
vi.mock('@/utils/getIp', () => ({ getIp: () => '203.0.113.9' }));
vi.mock('@/modules/billing/services/paystackClient', () => ({ initializeTransaction: vi.fn() }));

import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth/csrf';
import status from '../../../pages/api/billing/upgrade/status';
import start from '../../../pages/api/billing/upgrade/start';
import convert from '../../../pages/api/billing/upgrade/convert';

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
async function call(route: unknown, role: string, body: unknown = { planId: PLAN }, method = 'POST') {
  const res = makeRes();
  const req = {
    method, query: {}, body,
    headers: { [CSRF_HEADER]: TOKEN, 'user-agent': 'vitest' }, cookies: { [CSRF_COOKIE]: TOKEN },
    companyId: COMPANY, companyRole: role, user: { id: 'u-1', email: 'owner@example.com' },
  } as unknown as NextApiRequest;
  await (route as H)(req, res as unknown as NextApiResponse);
  return res;
}
const audits = () => h.admin.filter((a) => /^INSERT INTO audit_log/.test(a.text));
const writes = () => h.admin.filter((a) => /^(UPDATE|INSERT)/.test(a.text));

beforeEach(() => {
  h.admin.length = 0;
  h.flag = true;
  h.world = {
    company: { status: 'trial', trial_ends_at: '2026-12-01T00:00:00.000Z' },
    current: { id: 'sub-1', status: 'trial', plan_id: 'p-trial', current_period_end: '2026-12-01T00:00:00.000Z', is_paid: false },
    mandate: 'chargeable',
    plan: { code: 'starter', is_active: true, monthly_price_cents: 12300 },
  };
  vi.clearAllMocks();
  vi.mocked(initializeTransaction).mockResolvedValue({ reference: 'ref-1', accessCode: 'ac', authorizationUrl: 'https://pay.example/x' } as never);
});

describe('flag off', () => {
  it('every route answers 404 for every role and nothing is read or written', async () => {
    h.flag = false;
    for (const role of ['owner', 'admin', 'manager', 'viewer']) {
      expect((await call(status, role, undefined, 'GET')).statusCode, `status ${role}`).toBe(404);
      expect((await call(start, role)).statusCode, `start ${role}`).toBe(404);
      expect((await call(convert, role)).statusCode, `convert ${role}`).toBe(404);
    }
    expect(h.admin).toHaveLength(0);
    expect(initializeTransaction).not.toHaveBeenCalled();
    expect(vi.mocked(hasFeature).mock.calls.every(([c, code]) => c === COMPANY && code === 'trial_self_serve_upgrade')).toBe(true);
  });

  it('a failed flag read is off (fail closed)', async () => {
    vi.mocked(hasFeature).mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    expect((await call(convert, 'owner')).statusCode).toBe(404);
    expect(h.admin).toHaveLength(0);
  });
});

describe('roles', () => {
  it('admin, manager and viewer are refused (403) on every route before any read or write', async () => {
    for (const role of ['admin', 'manager', 'viewer']) {
      expect((await call(status, role, undefined, 'GET')).statusCode, `status ${role}`).toBe(403);
      expect((await call(start, role)).statusCode, `start ${role}`).toBe(403);
      expect((await call(convert, role)).statusCode, `convert ${role}`).toBe(403);
    }
    expect(h.admin).toHaveLength(0);
  });
});

describe('GET status', () => {
  it('returns the trial state and only the convertible plans, with prices from the plans table', async () => {
    const r = await call(status, 'owner', undefined, 'GET');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body!.data).toMatchObject({ onTrial: true, hasChargeableMandate: true, isPaid: false });
    expect((r.body!.data!.plans as Array<{ code: string }>).map((p) => p.code)).toEqual(['starter']);
  });
});

describe('POST start', () => {
  it('starts a checkout with the plan\'s price as the ceiling and the tenant return page as callback', async () => {
    h.world.mandate = 'none';
    const r = await call(start, 'owner');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body!.data).toEqual({ checkoutUrl: 'https://pay.example/x', reference: 'ref-1' });
    const insert = h.admin.find((a) => a.label === 'mandate_create')!;
    expect(insert.values).toEqual([COMPANY, 12300, 'u-1']);
    const cb = vi.mocked(initializeTransaction).mock.calls[0]![0].callbackUrl;
    expect(cb).toMatch(new RegExp(`/accounting/settings/billing/upgrade/return\\?plan=${PLAN}&ref=auth_`));
    expect(cb).not.toMatch(/\/admin\//);
  });

  it('refuses a company not on a trial (403) and one that already has an active mandate (409)', async () => {
    h.world.mandate = 'none';
    h.world.company = { status: 'active', trial_ends_at: null };
    expect((await call(start, 'owner')).statusCode).toBe(403);
    h.world.company = { status: 'trial', trial_ends_at: '2026-12-01T00:00:00.000Z' };
    h.world.mandate = 'pending_code';
    expect((await call(start, 'owner')).statusCode).toBe(409);
    expect(initializeTransaction).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it('refuses an unknown plan (404) and an internal or free plan (400)', async () => {
    h.world.mandate = 'none';
    h.world.plan = null;
    expect((await call(start, 'owner')).statusCode).toBe(404);
    h.world.plan = { code: 'payg', is_active: true, monthly_price_cents: 0 };
    expect((await call(start, 'owner')).statusCode).toBe(400);
    expect(initializeTransaction).not.toHaveBeenCalled();
  });
});

describe('POST convert', () => {
  it('requires a chargeable mandate: 409 and nothing written without one', async () => {
    for (const m of ['none', 'pending_code'] as const) {
      h.world.mandate = m;
      const r = await call(convert, 'owner');
      expect(r.statusCode, m).toBe(409);
    }
    expect(writes()).toHaveLength(0);
  });

  it('refuses a company not on a trial, or paying on another plan (403), with nothing written', async () => {
    h.world.company = { status: 'active', trial_ends_at: null };
    expect((await call(convert, 'owner')).statusCode).toBe(403);
    h.world.company = { status: 'active', trial_ends_at: '2026-10-01T00:00:00.000Z' };
    h.world.current = { id: 'sub-1', status: 'active', plan_id: OTHER_PLAN, current_period_end: '2026-12-01', is_paid: true };
    expect((await call(convert, 'owner')).statusCode).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it('converts on the migration_admin pool and writes one audit row in the same transaction', async () => {
    const r = await call(convert, 'owner');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body!.data).toMatchObject({ alreadyConverted: false, subscriptionId: 'sub-1', firstChargeAt: '2026-12-24T00:00:00.000Z' });
    const convertTx = h.admin.filter((a) => a.label === 'self_serve_convert');
    expect(convertTx.map((a) => a.text.slice(0, 22))).toContain('UPDATE companies SET s');
    expect(audits()).toHaveLength(1);
    expect(audits()[0]!.label).toBe('self_serve_convert');
    const v = audits()[0]!.values;
    expect(v[0]).toBe(COMPANY);
    expect(v[1]).toBe('u-1');
    expect(v[3]).toBe('update');
    const changes = JSON.parse(String(v.find((x) => typeof x === 'string' && x.startsWith('{"fields"'))));
    expect(changes.metadata).toMatchObject({ change: 'trial_self_serve_convert', planId: PLAN, subscriptionId: 'sub-1' });
  });

  it('is idempotent: the second call answers alreadyConverted, writes nothing and no second audit row', async () => {
    expect((await call(convert, 'owner')).statusCode).toBe(200);
    const before = writes().length;
    const again = await call(convert, 'owner');
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(again.body!.data).toMatchObject({ alreadyConverted: true, subscriptionId: 'sub-1' });
    expect(writes().length).toBe(before);
    expect(audits()).toHaveLength(1);
  });

  it('cannot target another company: a company id in the body is a 400, and every statement is the session company\'s', async () => {
    for (const body of [{ planId: PLAN, companyId: OTHER }, { planId: PLAN, company_id: OTHER }]) {
      expect((await call(convert, 'owner', body)).statusCode).toBe(400);
      expect((await call(start, 'owner', body)).statusCode).toBe(400);
    }
    expect(h.admin).toHaveLength(0);

    await call(convert, 'owner');
    const scoped = h.admin.filter((a) => /company_id|companies/.test(a.text));
    expect(scoped.length).toBeGreaterThan(0);
    for (const s of scoped) {
      expect(s.values, s.text).toContain(COMPANY);
      expect(s.values, s.text).not.toContain(OTHER);
    }
  });

  it('a malformed plan id is a 400', async () => {
    expect((await call(convert, 'owner', { planId: 'not-a-uuid' })).statusCode).toBe(400);
    expect(h.admin).toHaveLength(0);
  });
});
