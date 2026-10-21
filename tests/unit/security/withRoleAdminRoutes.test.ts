/**
 * withRole('admin') ranked roles through ROLE_HIERARCHY, so `system` and `super_admin` — ranked above admin,
 * and neither a company role — passed it. It is now an explicit allow-list of owner and admin. For each of
 * the ten routes that call it, on every method it gates: `system` and `super_admin` get 403 before any query
 * or provider call; `owner` and `admin` get past the gate. Only the auth wrappers, the DB and the Paystack
 * client are mocked; withRole and withWriteAccess are the real ones.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async () => []), { transaction: vi.fn(), unsafe: vi.fn(async () => []) });
  return {
    sql: sqlFn,
    withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/billing/services/paystackClient', () => ({
  initializeTransaction: vi.fn(async () => ({ reference: 'ref-1', accessCode: 'ac-1', authorizationUrl: 'https://checkout.example/x' })),
  disableSubscription: vi.fn(async () => undefined),
  verifyTransaction: vi.fn(async () => ({ status: 'pending' })),
}));

import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sql } from '@/lib/neon';
import { walk, stripComments } from './routeRoleGateCensus.helpers';
import { initializeTransaction, disableSubscription } from '@/modules/billing/services/paystackClient';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const API = join(__dirname, '../../../pages/api');
const ID = '33333333-3333-4333-8333-333333333333';
const ALL = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** Route (under pages/api), the methods withRole('admin') gates on it, and a body that reaches the gate. */
const ROUTES: Array<[string, string[], Record<string, unknown>]> = [
  ['billing/paystack/mandate/create', ALL, { maxAmountCents: 100000 }],
  ['billing/paystack/mandate/revoke', ALL, { mandateId: ID }],
  ['accounting/bank-rules-seed', ALL, {}],
  ['accounting/year-end', ALL, { yearLabel: 'FY2026' }],
  ['accounting/fiscal-periods-action', ALL, { action: 'reopen', id: ID }],
  ['accounting/opening-balances', ALL, {}],
  ['accounting/sage-migration-action', ALL, { action: 'noop' }],
  ['accounting/run-depreciation', ALL, {}],
  ['accounting/vat-declared-elsewhere', ALL, { action: 'mark', kind: 'customer', invoiceIds: [ID], reason: 'r' }],
  // GET lists locks for every member; withRole gates the unlock action only.
  ['accounting/vat-period-locks', ['POST'], { action: 'unlock', lockId: ID, reason: 'filed in error' }],
];
const CASES = ROUTES.flatMap(([route, methods, body]) => methods.map((m) => [route, m, body] as const));

async function load(route: string): Promise<H> {
  return (await import(/* @vite-ignore */ `../../../pages/api/${route}`)).default as H;
}
function makeRes() {
  const res = {
    statusCode: 200, body: undefined as { error?: { message?: string } } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  return res;
}
function makeReq(method: string, companyRole: string, body: Record<string, unknown>): NextApiRequest {
  return {
    method, headers: {}, cookies: {}, query: { id: ID }, body,
    companyId: '11111111-1111-4111-8111-111111111111', companyRole, user: { id: 'u-1', email: 'u@example.com' },
  } as unknown as NextApiRequest;
}
// withRole's refusal, or withWriteAccess's where it runs first (vat-declared-elsewhere and vat-period-locks POST).
const roleRefusal = (res: ReturnType<typeof makeRes>) =>
  res.statusCode === 403 && /requires admin role or higher|does not allow this action/.test(res.body?.error?.message ?? '');

// Load every route first: a service that builds a sql`` column fragment at import would otherwise count as a query.
beforeAll(async () => { for (const [route] of ROUTES) await load(route); }, 60_000);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockReset().mockImplementation((async () => []) as never); });

describe("withRole('admin') routes refuse system and super_admin", () => {
  it('covers every withRole call site in pages/api (read from disk, comments stripped)', () => {
    const hits = walk(API).filter((f) => stripComments(readFileSync(f, 'utf8')).includes('withRole('))
      .map((f) => relative(API, f).replace(/\.ts$/, '')).sort();
    expect(hits).toEqual(ROUTES.map(([r]) => r).sort());
  });

  it.each(CASES)('%s %s: system and super_admin get 403 before any query', async (route, method, body) => {
    const handler = await load(route);
    for (const role of ['system', 'super_admin']) {
      const res = makeRes();
      await handler(makeReq(method, role, body), res as unknown as NextApiResponse);
      expect(roleRefusal(res), `${role}: ${res.statusCode} ${JSON.stringify(res.body)}`).toBe(true);
    }
    expect(sql).not.toHaveBeenCalled();
    expect(initializeTransaction).not.toHaveBeenCalled();
    expect(disableSubscription).not.toHaveBeenCalled();
  });

  it.each(CASES)('%s %s: owner and admin get past the role gate', async (route, method, body) => {
    const handler = await load(route);
    for (const role of ['owner', 'admin']) {
      const res = makeRes();
      // Past the gate the handler runs against an empty mocked DB: it may answer 400/404/405, or throw on a
      // missing row (withErrorHandler is mocked away). It may not answer the role gate's 403.
      await handler(makeReq(method, role, body), res as unknown as NextApiResponse).catch(() => undefined);
      expect(roleRefusal(res), `${role}: ${res.statusCode} ${JSON.stringify(res.body)}`).toBe(false);
    }
  });
});
