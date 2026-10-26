/**
 * Budgets P2 batch save (spec §7.2): POST /api/accounting/budget-grid/save called as real members
 * through withAuth's request transaction. Deletes then upserts in one batch, tenant checks before
 * any write, one audit row, the updated_at compare-and-set (stale and concurrent saves), locked
 * versions (the compare-and-set and the lock trigger's BV001, both 409), roles and grain rules.
 * Every refusal leaves the version's amounts AND its token exactly as they were.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const hooks = vi.hoisted(() => ({ match: null as null | RegExp, fn: null as null | ((realSql: RawSql) => Promise<void>), fired: 0 }));

// Every statement runs on the real database. Once armed, the hook runs right after the first
// statement matching `match`, inside the same request transaction: after the compare-and-set on
// budget_versions (the only way to reach the lock trigger: the compare-and-set itself refuses a
// version that is already locked), or after the grain check (the way to reach the 23P01 backstop).
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { match, fn } = hooks;
    if (!match || !fn || !match.test(strings.join('?'))) return realSql(strings, ...values);
    return (async () => {
      const rows = await realSql(strings, ...values);
      hooks.match = null;
      hooks.fn = null;
      hooks.fired += 1;
      await fn(realSql);
      return rows;
    })();
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridSaveFixture, errCode, errMessage, type GridWorld } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { saveCells, type SaveCell } from '@/modules/accounting/services/budgets/gridSave';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const fx = budgetGridSaveFixture(pool, saveRoute, '/api/accounting/budget-grid/save');

let w: GridWorld;
let other: GridWorld;
let viewer: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  other = await fx.world();
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
  // The owner of w can also see the other company's accounts and centres (RLS shows every company
  // a user belongs to): only the service's company check keeps them out of w's version.
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'viewer', false)`,
    [other.u.homeCompanyId, w.u.userId]);
}, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other.u.homeCompanyId, w.u.userId]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 120000);

type Cell = { glAccountId: string; cc1Id?: string | null; cc2Id?: string | null; buId?: string | null; month: string; amount: number | null; clear?: boolean };
/** A cell as the grid sends it: a null amount (a delete) carries `clear: true`. */
const cell = (glAccountId: string, month: string, amount: number | null, dims: Partial<Cell> = {}): Cell =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}), ...dims });
const save = async (versionId: string, cells: Cell[], u: SetupUser = w.u, expectedUpdatedAt?: string) =>
  fx.call(u, { versionId, expectedUpdatedAt: expectedUpdatedAt ?? (await fx.token(versionId)), cells });
const k = (acct: string, month: string, amount: string, dims: { cc1?: string; cc2?: string; bu?: string } = {}) =>
  `${acct}|${dims.cc1 ?? ''}|${dims.cc2 ?? ''}|${dims.bu ?? ''}|${month}=${amount}`;
const data = (r: { body: { data?: unknown } }) => r.body.data as { updatedAt: string; saved: number; deleted: number };
const dump = (r: { status: number; body: unknown }) => JSON.stringify(r.body).slice(0, 300);

/** Asserts a refused save left the version untouched: same amounts, same token, no audit row. */
async function unchanged(versionId: string, run: () => Promise<{ status: number; body: unknown }>) {
  const before = { cells: await fx.cells(versionId), token: await fx.token(versionId), audits: (await fx.audits(versionId)).length };
  const r = await run();
  expect({ cells: await fx.cells(versionId), token: await fx.token(versionId), audits: (await fx.audits(versionId)).length }).toEqual(before);
  return r;
}

describe('POST /api/accounting/budget-grid/save', () => {
  it('deletes and upserts in one batch, answers the new token and counts, and writes one audit row', async () => {
    const v = await fx.version(w);
    const [m0, m1, m2] = w.months;
    await fx.amount(w, v, w.rent, m0!, 10);
    await fx.amount(w, v, w.rent, m1!, 20);
    const old = await fx.token(v);
    const r = await save(v, [cell(w.rent, m0!, 100.5), cell(w.rent, m1!, null), cell(w.sales, m2!, -50), cell(w.rent, m2!, 0)]);
    expect(r.status, dump(r)).toBe(200);
    expect([data(r).saved, data(r).deleted]).toEqual([3, 1]);
    expect(data(r).updatedAt).toBe(await fx.token(v));
    expect(data(r).updatedAt).not.toBe(old);
    expect(await fx.cells(v)).toEqual([k(w.rent, m0!, '100.50'), k(w.rent, m2!, '0.00'), k(w.sales, m2!, '-50.00')].sort());
    const audits = await fx.audits(v);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('update');
    expect(audits[0]!.changes.metadata).toMatchObject({ upserts: '3', deletes: '1', sumBefore: '30.00', sumAfter: '50.50', versionStatus: 'draft' });
  });

  it("another company's version is 404 and nothing of it changes", async () => {
    const theirs = await fx.version(other);
    await fx.amount(other, theirs, other.rent, other.months[0]!, 7);
    const r = await unchanged(theirs, () => save(theirs, [cell(other.rent, other.months[0]!, 99)]));
    expect([r.status, errCode(r as never)]).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
  });

  it("the service itself refuses another company's version: called on an owner connection, where RLS does not apply", async () => {
    const theirs = await fx.version(other);
    await fx.amount(other, theirs, other.rent, other.months[0]!, 7);
    const r = await unchanged(theirs, async () => {
      const out = await saveCells(w.u.homeCompanyId, w.u.userId,
        { versionId: theirs, expectedUpdatedAt: await fx.token(theirs), cells: [cell(w.rent, w.months[0]!, 99) as SaveCell] })
        .then(() => 'saved', (err: { code?: string }) => String(err.code));
      return { status: 0, body: out };
    });
    expect(r.body).toBe('BUDGET_VERSION_NOT_FOUND');
  });

  it("another company's account, centre or business unit is 400 and nothing is written", async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 5);
    const m = w.months[1]!;
    const tries: Cell[][] = [
      [cell(w.rent, m, 1), cell(other.rent, m, 1)],
      [cell(w.rent, m, 1, { cc1Id: other.cc1 })],
      [cell(w.sales, m, 1, { cc2Id: other.cc2 })],
      [cell(w.sales, m, 1, { buId: other.bu })],
      // A CC2 centre named as CC1 is not a CC1 of this company either.
      [cell(w.sales, m, 1, { cc1Id: w.cc2 })],
      [cell(w.asset, m, 1)],
    ];
    for (const cells of tries) {
      const r = await unchanged(v, () => save(v, cells));
      expect([r.status, errCode(r as never)], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
    }
  });

  it('a stale token is 409 BUDGET_VERSION_STALE with the current token and status, and nothing is written', async () => {
    const v = await fx.version(w, { status: 'approved' });
    const stale = await fx.token(v);
    await pool.query(`UPDATE budget_versions SET name = name || ' renamed' WHERE id = $1`, [v]);
    const current = await fx.token(v);
    const r = await unchanged(v, () => save(v, [cell(w.rent, w.months[0]!, 1)], w.u, stale));
    expect([r.status, errCode(r as never)]).toEqual([409, 'BUDGET_VERSION_STALE']);
    expect((r.body as { error: { details: Record<string, unknown> } }).error.details).toMatchObject({ currentUpdatedAt: current, status: 'approved' });
  });

  it('two concurrent saves with one token: exactly one 200 and one 409 STALE, and the winner is what is stored', async () => {
    const v = await fx.version(w);
    const t = await fx.token(v);
    const m = w.months[3]!;
    const [a, b] = await Promise.all([save(v, [cell(w.rent, m, 111)], w.u, t), save(v, [cell(w.rent, m, 222)], w.u, t)]);
    expect([a.status, b.status].sort(), `${dump(a)} ${dump(b)}`).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(errCode(loser)).toBe('BUDGET_VERSION_STALE');
    const won = a.status === 200 ? '111.00' : '222.00';
    expect(await fx.cells(v)).toEqual([k(w.rent, m, won)]);
    expect(await fx.audits(v)).toHaveLength(1);
  });

  it('a locked version is 409 BUDGET_VERSION_LOCKED and nothing is written', async () => {
    const v = await fx.version(w, { status: 'locked' });
    const r = await unchanged(v, () => save(v, [cell(w.rent, w.months[0]!, 1)]));
    expect([r.status, errCode(r as never)]).toEqual([409, 'BUDGET_VERSION_LOCKED']);
  });

  it("a lock that lands after the compare-and-set is refused by the trigger (BV001), answered 409, nothing written", async () => {
    const v = await fx.version(w, { status: 'approved' });
    await fx.amount(w, v, w.rent, w.months[0]!, 3);
    const userId = w.u.userId;
    hooks.fired = 0;
    hooks.match = /UPDATE budget_versions SET updated_at/;
    hooks.fn = async (realSql) => {
      await realSql`UPDATE budget_versions SET status = 'locked', locked_by = ${userId}, locked_at = clock_timestamp() WHERE id = ${v}::UUID`;
    };
    const r = await unchanged(v, () => save(v, [cell(w.rent, w.months[0]!, null), cell(w.rent, w.months[1]!, 9)]));
    hooks.match = null;
    expect(hooks.fired).toBe(1);
    expect([r.status, errCode(r as never)], dump(r)).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    // The lock was inside the save's savepoint, so it rolled back with the save.
    expect((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [v])).rows[0].status).toBe('approved');
  });

  it('a viewer is 403 and nothing is written', async () => {
    const v = await fx.version(w);
    const r = await unchanged(v, () => save(v, [cell(w.rent, w.months[0]!, 1)], viewer));
    expect(r.status).toBe(403);
  });

  it('a grain switch in one batch (delete the company cells, write CC1 cells) is accepted', async () => {
    const v = await fx.version(w);
    const [m0, m1] = w.months;
    await fx.amount(w, v, w.rent, m0!, 10);
    await fx.amount(w, v, w.rent, m1!, 20);
    const r = await save(v, [cell(w.rent, m0!, null), cell(w.rent, m1!, null), cell(w.rent, m0!, 15, { cc1Id: w.cc1 })]);
    expect(r.status, dump(r)).toBe(200);
    expect(await fx.cells(v)).toEqual([k(w.rent, m0!, '15.00', { cc1: w.cc1 })]);
  });

  it('a grain clash is 400 BUDGET_GRAIN_CONFLICT naming the account, and nothing is written', async () => {
    const v = await fx.version(w);
    const [m0, m1] = w.months;
    await fx.amount(w, v, w.rent, m0!, 10);
    await fx.amount(w, v, w.rent, m1!, 20);
    // Against stored rows: one company cell deleted, the other still there.
    const r = await unchanged(v, () => save(v, [cell(w.rent, m0!, null), cell(w.rent, m0!, 15, { buId: w.bu })]));
    expect([r.status, errCode(r as never)], dump(r)).toEqual([400, 'BUDGET_GRAIN_CONFLICT']);
    expect(errMessage(r as never)).toContain('BR-5000');
    // Inside the batch: one account at two grains.
    const r2 = await unchanged(v, () => save(v, [cell(w.sales, m0!, 1, { cc1Id: w.cc1 }), cell(w.sales, m1!, 1, { cc2Id: w.cc2 })]));
    expect([r2.status, errCode(r2 as never)]).toEqual([400, 'BUDGET_GRAIN_CONFLICT']);
    expect(errMessage(r2 as never)).toContain('GS-4000');
  });

  it('a grain clash that lands after the grain check hits the exclusion backstop (23P01): 400 BUDGET_GRAIN_CONFLICT, nothing written', async () => {
    const v = await fx.version(w);
    const [m0, m1] = w.months;
    await fx.amount(w, v, w.rent, m0!, 10);
    const companyId = w.u.homeCompanyId;
    let hookInserted = false;
    hooks.fired = 0;
    // Sales holds nothing in the version. Between the save's grain check and its company-grain
    // insert of Sales, a CC1 row for Sales arrives: it is accepted (no other grain yet), so it is the
    // SAVE's insert that breaks the exclusion. Written in the save's own transaction: a separate
    // one would wait on the version row the save holds.
    hooks.match = /dim_grain <> t\.g/;
    hooks.fn = async (realSql) => {
      await realSql`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
                    VALUES (${companyId}::UUID, ${v}::UUID, ${w.sales}::UUID, ${`${m1}-01`}::DATE, 5, ${w.cc1}::UUID)`;
      hookInserted = true;
    };
    // The savepoint takes the hook's row back with the save: amounts, token and audit rows as they were.
    const r = await unchanged(v, () => save(v, [cell(w.sales, m0!, 11)]));
    hooks.match = null;
    expect([hooks.fired, hookInserted]).toEqual([1, true]);
    expect([r.status, errCode(r as never)], dump(r)).toEqual([400, 'BUDGET_GRAIN_CONFLICT']);
  });

  it('refuses a bad batch before anything is written or the token moves', async () => {
    const v = await fx.version(w);
    await fx.amount(w, v, w.rent, w.months[0]!, 5);
    const m = w.months[1]!;
    const outside = `${w.label + 5}-01`;
    const bad: Array<[string, unknown[]]> = [
      ['Nothing to save', []],
      ['month', [cell(w.rent, outside, 1)]],
      ['cents', [cell(w.rent, m, 1.234)]],
      ['too large', [cell(w.rent, m, 1e13)]],
      ['twice', [cell(w.rent, m, 1), cell(w.rent, m, 2)]],
      ['one dimension', [cell(w.rent, m, 1, { cc1Id: w.cc1, buId: w.bu })]],
    ];
    for (const [needle, cells] of bad) {
      const r = await unchanged(v, async () => fx.call(w.u, { versionId: v, expectedUpdatedAt: await fx.token(v), cells }));
      expect(r.status, `${needle}: ${dump(r)}`).toBe(400);
      expect(errMessage(r as never).toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });
});
