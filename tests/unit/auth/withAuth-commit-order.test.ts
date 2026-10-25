// tests/unit/auth/withAuth-commit-order.test.ts
//
// Unit coverage for the commit-before-respond ordering guarantee in withAuth.
// Uses a mock pg client that records query order and a mock res whose
// json()/send() funnel through end() exactly like Next's api-resolver
// (next/dist/server/api-utils/node — sendData/sendJson both call res.end),
// so patching res.end inside withAuth is observable here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const COMPANY_ID = '00000000-0000-0000-0000-000000000cc1';

// ── Mock pg ─────────────────────────────────────────────────────────────────
// A mutable holder the hoisted vi.mock factory closes over, so each test can
// swap client behaviour after vi.resetModules() re-imports withAuth.
interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}
let currentClient: MockClient;
const poolFactory = {
  connect: vi.fn(async () => currentClient),
  on: vi.fn(),
};

vi.mock('pg', () => {
  class Pool {
    connect = poolFactory.connect;
    on = poolFactory.on;
  }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});

// checkRateLimit is only invoked for reports- prefix routes (not our test
// routes), but mock it so importing the module never touches a real backend.
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
// Usage-quota settlement (R-175): record what withAuth hands over, and when.
type Charge = { kind: 'ai' | 'send'; key: string; charged: number; used: number };
const settled: Charge[][] = [];
vi.mock('@/lib/rateLimitQuota', () => ({
  settleQuotaCharges: vi.fn(async (ctx: { quotaCharges?: Charge[] } | null) => {
    settled.push((ctx?.quotaCharges ?? []).map((c) => ({ ...c })));
  }),
}));

// ── Mock client builder ──────────────────────────────────────────────────────
function makeClient(opts: {
  events: string[];
  membershipRows?: Array<{ role: string; account_user_id: string | null; is_active: boolean | null; status: string | null; suspended_at: Date | null }>;
  commitThrows?: boolean;
}): MockClient {
  // Default: an active member. The membership lookup now LEFT JOINs
  // public.users, so the row must carry the account-standing columns or
  // withAuth denies before the handler runs.
  const membershipRows = opts.membershipRows ?? [{ role: 'admin', account_user_id: 'user-1', is_active: true, status: 'active', suspended_at: null }];
  return {
    query: vi.fn(async (text: string) => {
      const verb = typeof text === 'string' ? text.trim().split(/\s+/)[0]!.toUpperCase() : 'PARAM';
      if (/FROM (public\.)?company_users/i.test(String(text))) {
        opts.events.push('SELECT_MEMBERSHIP');
        return { rows: membershipRows };
      }
      if (verb === 'COMMIT' && opts.commitThrows) {
        opts.events.push('COMMIT_THROW');
        throw new Error('commit failed: serialization');
      }
      if (verb === 'BEGIN' || verb === 'COMMIT' || verb === 'ROLLBACK') {
        opts.events.push(verb);
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

// ── Mock res: json/send funnel through end, like Next ─────────────────────────
function makeRes(events: string[]) {
  const headers: Record<string, unknown> = {};
  const state = { statusCode: 200, headersSent: false, finished: false, body: undefined as unknown };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    get headersSent() { return state.headersSent; },
    get finished() { return state.finished; },
    get writableEnded() { return state.finished; },
    status(c: number) { state.statusCode = c; return res; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(v: unknown) { state.body = v; return res.send(JSON.stringify(v)); },
    send(v: unknown) { state.body = v; return res.end(v); },
    end(v?: unknown) {
      // The "real" flush. withAuth patches this; the patched version replays
      // here after COMMIT. Records exactly one FLUSH event.
      if (state.finished) return res;
      state.finished = true;
      state.headersSent = true;
      if (v !== undefined) state.body = v;
      events.push('FLUSH');
      return res;
    },
  };
  return { res: res as unknown as NextApiResponse, state, headers };
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReq(token: string, companyId: string, url = '/api/test') {
  return {
    headers: { cookie: `sb-access-token=${token}; active_company_id=${companyId}` },
    url,
  } as never;
}

describe('withAuth — commit-before-respond ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
    process.env.SENTRY_ENABLED = 'false';
    poolFactory.connect.mockClear();
    settled.length = 0;
  });

  it('COMMITs before flushing the response body on a 2xx', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    await withAuth(async (_req: never, r: NextApiResponse) => {
      r.status(200).json({ ok: true });
    })(mkReq(tok, COMPANY_ID), res);

    expect(events).toContain('COMMIT');
    expect(events).toContain('FLUSH');
    expect(events.indexOf('COMMIT')).toBeLessThan(events.indexOf('FLUSH'));
    expect(res.statusCode).toBe(200);
  });

  it('ROLLBACKs (not COMMITs) when the handler responds 5xx', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    await withAuth(async (_req: never, r: NextApiResponse) => {
      // Mimics withErrorHandler catching an error and responding 500.
      r.status(500).json({ success: false, message: 'boom' });
    })(mkReq(tok, COMPANY_ID), res);

    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(res.statusCode).toBe(500);
    // The 500 body is still delivered, after the rollback.
    expect(events.indexOf('ROLLBACK')).toBeLessThan(events.indexOf('FLUSH'));
  });

  it('turns a failed COMMIT after a 2xx into a 500 (no silent lie)', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events, commitThrows: true });
    const { res, state } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    await withAuth(async (_req: never, r: NextApiResponse) => {
      r.status(200).json({ ok: true });
    })(mkReq(tok, COMPANY_ID), res);

    expect(events).toContain('COMMIT_THROW');
    expect(state.statusCode).toBe(500);
    expect(state.finished).toBe(true); // a response WAS sent
  });

  // S-07e: what committed on its own connection (a Flows debit) is undone when
  // the request does not commit; never when it does.
  it.each([
    ['a failed COMMIT after a 2xx', { commitThrows: true }, 200, true],
    ['a 5xx', {}, 500, true],
    ['a throw', {}, 'throw', true],
    ['a committed 2xx', {}, 200, false],
  ] as const)('runs after-rollback work on %s: %s', async (_, clientOpts, outcome, runs) => {
    const events: string[] = [];
    currentClient = makeClient({ events, ...clientOpts });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const { runAfterRollback } = await import('@/lib/afterCommit');
    const tok = await makeToken('user-1');
    const undo = vi.fn(async () => undefined);

    await withAuth(async (_req: never, r: NextApiResponse) => {
      runAfterRollback('undo the debit', undo);
      if (outcome === 'throw') throw new Error('handler threw');
      r.status(outcome).json({ ok: outcome < 500 });
    })(mkReq(tok, COMPANY_ID), res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(undo).toHaveBeenCalledTimes(runs ? 1 : 0);
  });

  it('flushes exactly once when the handler calls end twice', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    await withAuth(async (_req: never, r: NextApiResponse) => {
      r.status(200).json({ ok: true });
      r.end();
    })(mkReq(tok, COMPANY_ID), res);

    expect(events.filter((e) => e === 'FLUSH')).toHaveLength(1);
    expect(events.indexOf('COMMIT')).toBeLessThan(events.indexOf('FLUSH'));
  });

  it('ROLLBACKs, then answers 500 itself, when the handler throws without responding (R-159)', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    // A handler that throws BEFORE responding (bypasses withErrorHandler) hits
    // withAuth's outer catch: ROLLBACK, then one 500 through the real end. It
    // used to rethrow with end still buffered, so no answer ever reached the client.
    await expect(
      withAuth(async () => { throw new Error('handler exploded'); })(mkReq(tok, COMPANY_ID), res),
    ).resolves.toBeUndefined();

    expect(events).not.toContain('COMMIT');
    expect(events.filter((e) => e === 'FLUSH')).toHaveLength(1);
    expect(events.indexOf('ROLLBACK')).toBeLessThan(events.indexOf('FLUSH'));
    expect(res.statusCode).toBe(500);
  });

  it('COMMITs (preserves current behaviour) on a 4xx response', async () => {
    const events: string[] = [];
    currentClient = makeClient({ events });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const tok = await makeToken('user-1');

    await withAuth(async (_req: never, r: NextApiResponse) => {
      r.status(404).json({ success: false, message: 'not found' });
    })(mkReq(tok, COMPANY_ID), res);

    expect(events).toContain('COMMIT');
    expect(events).not.toContain('ROLLBACK');
    expect(res.statusCode).toBe(404);
  });

  // ── R-175: every exit settles the request's usage quota ────────────────────
  // The handler notes a charge the way checkSendRateLimit does and records use
  // the way the email client does, on the request context.
  async function runCharged(used: number, respond: (r: NextApiResponse) => void, clientOpts: { commitThrows?: boolean } = {}) {
    const events: string[] = [];
    currentClient = makeClient({ events, ...clientOpts });
    const { res } = makeRes(events);
    const { withAuth } = await import('@/lib/auth/withAuth');
    const { als } = await import('@/lib/als');
    await withAuth(async (_req: never, r: NextApiResponse) => {
      const charge: Charge = { kind: 'send', key: 'send:x:co:c:day', charged: 100, used: 0 };
      als.getStore()!.quotaCharges!.push(charge);
      charge.used = used;
      respond(r);
    })(mkReq(await makeToken('user-1'), COMPANY_ID), res);
    return { events, res };
  }
  const handedOver = (used: number) => [[{ kind: 'send', key: 'send:x:co:c:day', charged: 100, used }]];

  it.each([
    ['a 200', 200], ['a 400', 400], ['a 429', 429], ['a 500', 500], ['a 503', 503],
  ])('settles the usage quota after %s, with the use the request recorded', async (_label, status) => {
    await runCharged(59, (r) => { r.status(status).json({}); });

    expect(settled).toEqual(handedOver(59));
    expect(currentClient.release).toHaveBeenCalledTimes(1);
  });

  it('settles when the handler throws, keeping what was used before the throw', async () => {
    await runCharged(59, () => { throw new Error('recipient 60 blew up'); });

    expect(settled).toEqual(handedOver(59));
  });

  it('settles when the COMMIT fails after a 2xx: the work was done, the use stands', async () => {
    const { res } = await runCharged(100, (r) => { r.status(200).json({ ok: true }); }, { commitThrows: true });

    expect(res.statusCode).toBe(500);
    expect(settled).toEqual(handedOver(100));
  });
});
