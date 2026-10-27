/**
 * Budgets P2 batch save, size, rate and cost (rounds 2 and 9): Next's own body parser reads the
 * body before withAuth, limited to 4 MB (it answers 413 past that; MAX_SAVE_CELLS widest cells fit,
 * pinned by tests/unit/api/budgetGridSaveLimits); a batch over MAX_SAVE_CELLS is refused; a user's
 * save bucket is charged in the handler (429 with Retry-After when full); a cell re-saved with its
 * amount unchanged is not touched (its updated_at still says when it last changed); and the
 * largest batch holds the version row briefly for an insert, an update and a delete (a wall-clock
 * bound, asserted by hand only). Real PostgreSQL through the real route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const stamps = vi.hoisted(() => ({ cas: 0 }));

// Every statement runs on the real database; the compare-and-set's start is stamped (the version row is held from there to the commit).
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (/UPDATE budget_versions SET updated_at/.test(strings.join('?'))) stamps.cas = Date.now();
    return realSql(strings, ...values);
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import saveRoute, { config } from '../../pages/api/accounting/budget-grid/save';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSave';
import { IN_INTEGRATION_GATE } from '../helpers/integrationGate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, clearBudgetRateCounters, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const URL = '/api/accounting/budget-grid/save';
let A: GridCo;

beforeAll(async () => { A = await fx.company(); }, 120000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 600000);

const token = async (id: string) => String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [id])).rows[0].t);
const cell = (glAccountId: string, month: string, amount: number | null, cc1Id: string | null = null) =>
  ({ glAccountId, cc1Id, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}) });
const save = (body: unknown) => fx.call(saveRoute, URL, A.owner, 'POST', {}, body);
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

describe('save: the body and the request', () => {
  it("Next's body parser reads the save, limited to 4 MB", () => {
    expect(config.api.bodyParser).toEqual({ sizeLimit: '4mb' });
  });

  it("the request log holds no cell data: withErrorHandler's request line shows the cells as a count", async () => {
    const v = await fx.version(A);
    const marker = 4321.98;
    const cells = Array.from({ length: 60 }, (_, i) => cell(A.acct.rent, FY27[i % 12]!, marker + i, i < 12 ? null : A.cc1));
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    let r;
    try {
      r = await save({ versionId: v, expectedUpdatedAt: await token(v), cells: cells.map((c, i) => ({ ...c, month: FY27[i % 12]! })) });
    } finally {
      process.stdout.write = write;
    }
    expect(r.status).not.toBe(500);
    const requestLine = lines.find((l) => l.includes('API Request: POST'));
    expect(requestLine).toContain('[omitted: 60 items]');
    expect(lines.filter((l) => l.includes(String(marker)) || l.includes(A.acct.rent))).toEqual([]);
  });

  it('a save without a CSRF match is 403 and writes nothing (no route census covers CSRF)', async () => {
    const v = await fx.version(A);
    const before = await token(v);
    const req = request({ 'sb-access-token': A.owner.token, active_company_id: A.id }, 'POST') as unknown as Record<string, unknown> & { headers: Record<string, string> };
    Object.assign(req, { url: URL, query: {}, body: { versionId: v, expectedUpdatedAt: before, cells: [cell(A.acct.rent, FY27[0]!, 5)] },
      headers: { ...req.headers, 'x-csrf-token': 'x'.repeat(44) } });
    const out = response();
    await (saveRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(403);
    expect(await token(v)).toBe(before);
  });

  it('a user whose save bucket is full is 429 with Retry-After 60, and nothing is written', async () => {
    const v = await fx.version(A);
    const before = await token(v);
    await pool.query(`INSERT INTO rate_limit_counters (key, count, window_start) VALUES ($1, 120, now())
                      ON CONFLICT (key) DO UPDATE SET count = 120, window_start = now()`, [`budget-save:${A.owner.userId}`]);
    try {
      const r = await save({ versionId: v, expectedUpdatedAt: before, cells: [cell(A.acct.rent, FY27[0]!, 5)] });
      expect([r.status, r.body.error?.code], dump(r)).toEqual([429, 'RATE_LIMIT']);
      expect(await token(v)).toBe(before);
    } finally {
      await clearBudgetRateCounters(pool, [A.owner.userId]);
    }
  });

  it(`a batch over MAX_SAVE_CELLS (${MAX_SAVE_CELLS}) is refused before anything is read`, async () => {
    const v = await fx.version(A);
    const before = await token(v);
    const cells = Array.from({ length: MAX_SAVE_CELLS + 1 }, (_, i) => cell(A.acct.rent, FY27[i % 12]!, i));
    const r = await save({ versionId: v, expectedUpdatedAt: before, cells });
    expect(r.status, dump(r)).toBe(422);
    expect(await token(v)).toBe(before);
  });
});

describe('save: what a write touches', () => {
  it('a cell re-saved with the same amount keeps its updated_at; a changed one moves', async () => {
    const v = await fx.version(A);
    const [m0, m1] = FY27;
    expect((await save({ versionId: v, expectedUpdatedAt: await token(v), cells: [cell(A.acct.rent, m0!, 10), cell(A.acct.rent, m1!, 20)] })).status).toBe(200);
    const stamp = async () => Object.fromEntries((await pool.query(
      `SELECT to_char(month, 'YYYY-MM') m, updated_at::text u FROM budget_month_amounts WHERE version_id = $1`, [v])).rows.map((x) => [x.m, x.u]));
    const before = await stamp();
    const r = await save({ versionId: v, expectedUpdatedAt: await token(v), cells: [cell(A.acct.rent, m0!, 10), cell(A.acct.rent, m1!, 21)] });
    expect(r.status, dump(r)).toBe(200);
    const after = await stamp();
    expect(after[m0!]).toBe(before[m0!]);
    expect(after[m1!]).not.toBe(before[m1!]);
  });
});

describe('save: the largest batch', () => {
  // ci-integration-skip: the wall-clock bound is not asserted inside the CI gate (six shards on a shared box at load 50-250 time the machine, not the code); a run by hand asserts it, with the correctness checks.
  // MAX_SAVE_CELLS is 20 000 (round 9): measured ~2 s at box load ~20, so the bound allows 5 s.
  it.skipIf(IN_INTEGRATION_GATE)(`${MAX_SAVE_CELLS} cells: insert, update and delete each hold the version a few seconds at most`, async () => {
    const members = (await pool.query(
      `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
       SELECT gen_random_uuid(), $1, 'K' || lpad(g::text, 5, '0'), 'K ' || g, 'cc1', true FROM generate_series(1, 1667) g RETURNING id`, [A.id])).rows.map((x) => String(x.id));
    const accts = [A.acct.sales, A.acct.otherIncome, A.acct.cos, A.acct.rent, A.acct.childA];
    const v = await fx.version(A, { name: 'BIG' });
    const cells = (amount: number | null) => {
      const out: unknown[] = [];
      for (const a of accts) for (const m of members) for (const month of FY27) if (out.length < MAX_SAVE_CELLS) out.push(cell(a, month, amount, m));
      return out;
    };
    const held: Record<string, number> = {};
    for (const [label, amount, rows] of [['insert', 12.34, MAX_SAVE_CELLS], ['update', 56.78, MAX_SAVE_CELLS], ['delete', null, 0]] as const) {
      const body = { versionId: v, expectedUpdatedAt: await token(v), cells: cells(amount) };
      stamps.cas = 0;
      const r = await save(body);
      held[label] = Date.now() - stamps.cas;
      expect(r.status, `${label}: ${dump(r)}`).toBe(200);
      const n = (await pool.query('SELECT COUNT(*)::int n, COALESCE(SUM(amount), 0)::text s FROM budget_month_amounts WHERE version_id = $1', [v])).rows[0];
      expect([n.n, n.s], label).toEqual([rows, amount === null ? '0' : (amount * MAX_SAVE_CELLS).toFixed(2)]);
    }
    process.stderr.write(`[save-cost] version held ms ${JSON.stringify(held)}\n`);
    expect(held, JSON.stringify(held)).toMatchObject({ insert: expect.any(Number), update: expect.any(Number), delete: expect.any(Number) });
    for (const [label, ms] of Object.entries(held)) expect(ms, label).toBeLessThanOrEqual(5_000);
  }, 600000);
});
