/**
 * #1656: a user the admin portal linked as an accountant or bookkeeper (its working roles until
 * #1656) got a 403 on every write in the app, because withWriteAccess admits owner, admin and
 * manager only. Such a row now reads as manager (companyRoles.ts LEGACY_ROLE_MAP, applied by
 * withAuth through normalizeCompanyRole; migration 1010 rewrites the stored rows), so the user
 * can write. storeman / technician / user were read-only and stay so (viewer).
 *
 * Through the real withAuth and withWriteAccess; only pg and the token are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'b'.repeat(40);
const COMPANY_ID = '00000000-0000-0000-0000-000000001656';
const USER_ID = '16561656-1656-4656-8656-165616561656';

interface MockClient { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
let currentClient: MockClient;
const poolFactory = { connect: vi.fn(async () => currentClient), on: vi.fn() };

vi.mock('pg', () => {
  class Pool { connect = poolFactory.connect; on = poolFactory.on; }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));
vi.mock('@/lib/als', () => ({ als: { run: vi.fn((_s: unknown, cb: () => unknown) => cb()) } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

function clientWithRole(role: string): MockClient {
  const row = { role, account_user_id: USER_ID, is_active: true, status: 'active', suspended_at: null };
  return {
    query: vi.fn(async (text: string) => (/FROM (public\.)?company_users/i.test(String(text)) ? { rows: [row] } : { rows: [] })),
    release: vi.fn(),
  };
}

function makeRes() {
  const headers: Record<string, unknown> = {};
  const state = { statusCode: 200, finished: false };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    get headersSent() { return state.finished; },
    status(c: number) { state.statusCode = c; return res; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(v: unknown) { return res.send(JSON.stringify(v)); },
    send(v: unknown) { return res.end(v); },
    end() { state.finished = true; return res; },
  };
  return { res: res as unknown as NextApiResponse, state };
}

async function token() {
  return new SignJWT({ sub: USER_ID, email: 'x@y.z', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

beforeEach(() => {
  vi.resetModules();
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.GOTRUE_URL = 'http://example.test/auth/v1';
  process.env.DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
  process.env.SENTRY_ENABLED = 'false';
});

/** A POST through withAuth(withWriteAccess(handler)) by a member whose stored role is `role`. */
async function post(role: string) {
  currentClient = clientWithRole(role);
  const { withAuth } = await import('@/lib/auth/withAuth');
  const { withWriteAccess } = await import('@/lib/auth/withWriteAccess');
  const seen: string[] = [];
  const handler = vi.fn(async (req: { companyRole: string }, r: NextApiResponse) => { seen.push(req.companyRole); r.status(200).json({ ok: true }); });
  const { res } = makeRes();
  const req = { method: 'POST', headers: { cookie: `sb-access-token=${await token()}; active_company_id=${COMPANY_ID}` }, url: '/api/accounting/x' };
  await withAuth(withWriteAccess(handler as never) as never)(req as never, res);
  return { status: res.statusCode, ran: handler.mock.calls.length, seen };
}

describe('a legacy role the admin portal granted (#1656)', () => {
  it.each(['accountant', 'bookkeeper'])('%s can write: it reads as manager', async (role) => {
    const out = await post(role);
    expect(out.ran).toBe(1);
    expect(out.status).toBe(200);
    expect(out.seen).toEqual(['manager']);
  });

  it.each(['storeman', 'technician', 'user'])('%s stays read-only: it reads as viewer and a write is 403', async (role) => {
    const out = await post(role);
    expect(out.ran).toBe(0);
    expect(out.status).toBe(403);
  });
});
