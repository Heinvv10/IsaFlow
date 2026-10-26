/**
 * What early reads may hold (round 5, security review MEDIUM): the process budget counts bytes
 * actually RECEIVED, not declared Content-Length, so accounts that declare large bodies and send
 * little cannot fill it and make other users' saves 503; each user may hold at most one route
 * maxBytes in flight (429 past it); bytes received do count against the process budget (503 past
 * it); and a small save has a lane outside that budget, so it saves even when the budget is full. Real route, real PostgreSQL; bodies are in-process streams.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Readable } from 'node:stream';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { earlyReadStats } from '@/lib/readJsonBody';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const MB = 1048576;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let A: GridCo, B: GridCo, C: GridCo, D: GridCo, E: GridCo;

beforeAll(async () => {
  [A, B, C, D, E] = [await fx.company(), await fx.company(), await fx.company(), await fx.company(), await fx.company()];
}, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 120000);

/** A body that sends `sendBytes` at once, then nothing until `release()` (when it ends). */
function sendsThenHolds(sendBytes: number) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stream = Readable.from((async function* gen() {
    for (let sent = 0; sent < sendBytes; sent += MB) yield Buffer.alloc(Math.min(MB, sendBytes - sent), 0x20);
    await released;
  })());
  return { stream, release };
}

async function post(c: GridCo, stream: Readable, declared: number | null) {
  const base = request({ 'sb-access-token': c.owner.token, active_company_id: c.id }, 'POST') as unknown as { headers: Record<string, string> };
  const req = Object.assign(stream, base, {
    url: '/api/accounting/budget-grid/save', query: {},
    headers: { ...base.headers, 'content-type': 'application/json', ...(declared === null ? {} : { 'content-length': String(declared) }) },
  });
  const out = response();
  await (saveRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body as { error?: { code?: string; details?: { code?: string } } } };
}

async function smallSave(c: GridCo) {
  const v = await fx.version(c);
  const t = String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [v])).rows[0].t);
  const json = Buffer.from(JSON.stringify({ versionId: v, expectedUpdatedAt: t, cells: [{ glAccountId: c.acct.rent, cc1Id: null, cc2Id: null, buId: null, month: FY27[0], amount: 5 }] }));
  return post(c, Readable.from([json]), json.length);
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 500 && !cond(); i++) await sleep(10);
  expect(cond(), what).toBe(true);
}

describe('early-read byte budgets', () => {
  it('accounts that DECLARE large bodies and send little cannot make another user\'s small save 503', async () => {
    // Three accounts declare 18 (A), 18 (B), 18+10 (C): 64 MB, the whole process budget had declarations counted. Each sends 64 KB.
    const held = [[A, 18], [B, 18], [C, 18], [C, 10]].map(([c, mb]) => ({ c: c as GridCo, mb: mb as number, s: sendsThenHolds(64 * 1024) }));
    const pending = held.map((h) => post(h.c, h.s.stream, h.mb * MB));
    await until(() => earlyReadStats().reads === 4, 'four large uploads being read');
    const victim = await smallSave(D);
    for (const h of held) h.s.release();
    await Promise.all(pending);
    expect([victim.status, victim.body.error?.code], JSON.stringify(victim.body)).toEqual([200, undefined]);
  }, 60000);

  it('one user holds at most 18 MB in flight: a second upload that would pass it is 429, another user is unaffected', async () => {
    const first = sendsThenHolds(10 * MB);
    const pendingFirst = post(A, first.stream, null);
    await until(() => earlyReadStats().bytes >= 10 * MB, 'the first 10 MB received');
    const second = sendsThenHolds(10 * MB);
    const r = await post(A, second.stream, null);
    second.release();
    expect([r.status, r.body.error?.details?.code], JSON.stringify(r.body)).toEqual([429, 'EARLY_READ_USER_BUDGET']);
    expect((await smallSave(B)).status).toBe(200);
    first.release();
    await pendingFirst;
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  }, 60000);

  it('bytes RECEIVED count against the 64 MB process budget: the upload that crosses it is 503, mid-read', async () => {
    const holders = [A, B, C].map((c) => ({ c, s: sendsThenHolds(18 * MB) }));
    const pending = holders.map((h) => post(h.c, h.s.stream, null));
    await until(() => earlyReadStats().bytes >= 54 * MB, '54 MB received by three users');
    const crossing = sendsThenHolds(18 * MB);
    const r = await post(D, crossing.stream, null);
    crossing.release();
    for (const h of holders) h.s.release();
    await Promise.all(pending);
    expect([r.status, r.body.error?.details?.code], JSON.stringify(r.body)).toEqual([503, 'EARLY_READ_PROCESS_BUDGET']);
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  }, 60000);

  it('with the process budget FULL of large uploads, a normal small save from another user still saves; a large one is 503', async () => {
    // A, B, C hold 18 MB each and D 10 MB: 64 MB of large bodies received and held.
    const holders = [[A, 18], [B, 18], [C, 18], [D, 10]].map(([c, mb]) => ({ c: c as GridCo, s: sendsThenHolds((mb as number) * MB) }));
    const pending = holders.map((h) => post(h.c, h.s.stream, null));
    await until(() => earlyReadStats().bytes >= 64 * MB, 'the 64 MB process budget full');
    const small = await smallSave(E);
    const large = sendsThenHolds(2 * MB);
    const refused = await post(E, large.stream, null);
    large.release();
    for (const h of holders) h.s.release();
    await Promise.all(pending);
    expect([small.status, small.body.error?.code], JSON.stringify(small.body)).toEqual([200, undefined]);
    expect([refused.status, refused.body.error?.details?.code]).toEqual([503, 'EARLY_READ_PROCESS_BUDGET']);
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  }, 60000);
});
