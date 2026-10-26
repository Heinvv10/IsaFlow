/**
 * Budgets P2 batch save, the request edges (round-1 findings BRK-L4, BRK-L5, R7): a token that
 * looks like a timestamp but is no real one (30 February, offset +99, year 0) is refused before
 * the database parses it, never a 500; a well-formed wrong token is 409 STALE; an amount above
 * NUMERIC(15,2)'s ceiling (but under 10^13) is a 400, never a RangeError 500; a cost centre with
 * NULL cc_type is not offered as a CC1 member by the read model and is refused by the save.
 * Real PostgreSQL through the real routes; every refusal leaves the version as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import gridRoute from '../../pages/api/accounting/budget-grid/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
let A: GridCo;
let nullTypeCentre: string;

beforeAll(async () => {
  A = await fx.company();
  nullTypeCentre = String((await pool.query(
    `INSERT INTO cost_centres (company_id, code, name, cc_type, is_active) VALUES ($1, 'GNULL', 'Untyped', NULL, true) RETURNING id`, [A.id])).rows[0].id);
}, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const token = async (id: string) => String((await pool.query(`SELECT ${TOKEN_SQL} t FROM budget_versions WHERE id = $1`, [id])).rows[0].t);
const cell = (glAccountId: string, month: string, amount: number | null, dims: Record<string, string | null> = {}) =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}), ...dims });
const save = (versionId: string, expectedUpdatedAt: string, cells: unknown[]) =>
  fx.call(saveRoute, '/api/accounting/budget-grid/save', A.owner, 'POST', {}, { versionId, expectedUpdatedAt, cells });
const code = (r: { body: { error?: { details?: { code?: string } } } }) => r.body.error?.details?.code;
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const stored = async (v: string) => (await pool.query(
  `SELECT to_char(month, 'YYYY-MM') m, amount::text a FROM budget_month_amounts WHERE version_id = $1 ORDER BY 1`, [v])).rows;

async function unchanged(v: string, run: () => Promise<{ status: number; body: unknown }>) {
  const before = { rows: await stored(v), token: await token(v) };
  const r = await run();
  expect({ rows: await stored(v), token: await token(v) }, dump(r)).toEqual(before);
  return r;
}

describe('save: the token', () => {
  it('a timestamp-shaped token that is no real timestamp is a 4xx validation error, never a 500', async () => {
    const v = await fx.version(A);
    for (const bad of ['2026-02-30T10:00:00Z', '2026-10-26T10:00:00+99', '0000-01-01T00:00:00Z', '2027-02-29T00:00:00Z', '2026-10-26T24:00:00Z']) {
      const r = await unchanged(v, () => save(v, bad, [cell(A.acct.rent, FY27[1]!, 1)]));
      expect(r.status, `${bad}: ${dump(r)}`).toBe(422);
    }
  });

  it('a well-formed wrong token is 409 STALE; the Postgres form of the right one saves', async () => {
    const v = await fx.version(A);
    const real = await token(v);
    for (const wrong of [real.slice(0, 19) + 'Z', '2099-01-01T00:00:00Z', '2028-02-29T12:00:00+02:00']) {
      const r = await unchanged(v, () => save(v, wrong, [cell(A.acct.rent, FY27[1]!, 1)]));
      expect([r.status, code(r)], dump(r)).toEqual([409, 'BUDGET_VERSION_STALE']);
    }
    const pgForm = real.replace('T', ' ').replace('Z', '+00');
    const ok = await save(v, pgForm, [cell(A.acct.rent, FY27[1]!, 1)]);
    expect(ok.status, dump(ok)).toBe(200);
  });
});

describe('save: amounts at the ceiling', () => {
  it('the largest NUMERIC(15,2) amount saves; anything above it (and under 10^13) is a 400, never a 500', async () => {
    const v = await fx.version(A);
    const top = await save(v, await token(v), [cell(A.acct.rent, FY27[2]!, 9999999999999.99), cell(A.acct.sales, FY27[2]!, -9999999999999.99)]);
    expect(top.status, dump(top)).toBe(200);
    for (const over of [9999999999999.996, -9999999999999.996, 9999999999999.998]) {
      const r = await unchanged(v, async () => save(v, await token(v), [cell(A.acct.rent, FY27[3]!, over)]));
      expect([r.status, code(r)], `${over}: ${dump(r)}`).toEqual([400, 'BUDGET_VERSION_INPUT']);
    }
  });
});

describe('save: delete is explicit (round-3 N3)', () => {
  it('a null amount without clear: true is 400 naming the cell, and the cell is kept: a NaN in a client arrives as null', async () => {
    const v = await fx.version(A);
    await fx.amount(A, v, A.acct.rent, FY27[4]!, 70);
    for (const amount of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bare = { glAccountId: A.acct.rent, cc1Id: null, cc2Id: null, buId: null, month: FY27[4]!, amount };
      const r = await unchanged(v, async () => save(v, await token(v), [bare]));
      expect([r.status, code(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
      expect(String(r.body.error?.message)).toContain(`account ${A.acct.rent} month ${FY27[4]}`);
    }
    const no = await unchanged(v, async () => save(v, await token(v), [{ ...cell(A.acct.rent, FY27[4]!, null), clear: false }]));
    expect(no.status, dump(no)).toBe(400);
  });

  it('clear: true with an amount is 400; null with clear: true deletes', async () => {
    const v = await fx.version(A);
    await fx.amount(A, v, A.acct.rent, FY27[5]!, 80);
    const both = await unchanged(v, async () => save(v, await token(v), [{ ...cell(A.acct.rent, FY27[5]!, 81), clear: true }]));
    expect([both.status, code(both)], dump(both)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(String(both.body.error?.message)).toContain('clear: true');
    const del = await save(v, await token(v), [cell(A.acct.rent, FY27[5]!, null)]);
    expect(del.status, dump(del)).toBe(200);
    expect(await stored(v)).toEqual([]);
  });
});

describe('save: ids are compared lower-cased (round-5 M1)', () => {
  it('an UPPER-CASE header or inactive account id is still refused by decision 18', async () => {
    const v = await fx.version(A);
    for (const acct of [A.acct.header, A.acct.inactive]) {
      const r = await unchanged(v, async () => save(v, await token(v), [cell(acct.toUpperCase(), FY27[6]!, 10)]));
      expect([r.status, code(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    }
  });

  it('two case variants of one cell are a 400 duplicate, not a 500', async () => {
    const v = await fx.version(A);
    const r = await unchanged(v, async () => save(v, await token(v),
      [cell(A.acct.rent, FY27[7]!, 1), cell(A.acct.rent.toUpperCase(), FY27[7]!, 2)]));
    expect([r.status, code(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    expect(String(r.body.error?.message)).toContain('appears twice');
  });
});

describe('a cost centre with NULL cc_type (R7)', () => {
  it('is not offered as a CC1 member by the read model', async () => {
    const v = await fx.version(A);
    const r = await fx.call(gridRoute, '/api/accounting/budget-grid', A.owner, 'GET', { version_id: v });
    expect(r.status, dump(r)).toBe(200);
    const dims = (r.body.data as { dimensions: Record<'cc1' | 'cc2', Array<{ id: string }>> }).dimensions;
    expect(dims.cc1.map((m) => m.id)).toContain(A.cc1);
    expect(dims.cc1.map((m) => m.id)).not.toContain(nullTypeCentre);
    expect(dims.cc2.map((m) => m.id)).not.toContain(nullTypeCentre);
  });

  it('is refused by the save as a CC1, with nothing written', async () => {
    const v = await fx.version(A);
    const r = await unchanged(v, async () => save(v, await token(v), [cell(A.acct.rent, FY27[0]!, 5, { cc1Id: nullTypeCentre })]));
    expect([r.status, code(r)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
  });
});
