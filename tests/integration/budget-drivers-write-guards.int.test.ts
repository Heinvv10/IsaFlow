/**
 * Budgets P4 driver writes (spec §5, §9 `budget-drivers-locked` API part): every driver, hire,
 * reset and refresh write on a LOCKED version is 409 BUDGET_VERSION_LOCKED with nothing written,
 * and the lock is taken FIRST (a locked version naming a bad account is still 409, not 400); a
 * write that closes a loop is 400 DRIVER_CYCLE with the path and writes nothing; months outside
 * the version are 400 DRIVER_REF; another company's version, account or centre is refused; a
 * viewer is 403; a successful write moves the version's token and answers it. Real members
 * through withAuth, whose transaction COMMITs a 4xx: a refusal must have rolled itself back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, details, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { driverFixture } from './helpers/budgetDriverFixture';
import { errCode } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const { driver: insertDriver } = driverFixture();
let w: DriverWorld;
let other: DriverWorld;
let viewer: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  other = await fx.world();
  viewer = await fx.member(w.u.homeCompanyId, 'viewer');
}, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const fixed = (versionId: string, acct: string, extra: Record<string, unknown> = {}) =>
  ({ versionId, glAccountId: acct, kind: 'fixed', amount: 1500, fromMonth: w.months[0], toMonth: w.months[11], ...extra });
const pctOf = (versionId: string, acct: string, ref: string) =>
  ({ versionId, glAccountId: acct, kind: 'pct_of_line', pct: 10, fromMonth: w.months[0], toMonth: w.months[11], ref: { glAccountId: ref } });

/** Runs `write` and asserts it left the version exactly as it was. */
async function refused(versionId: string, write: () => Promise<RouteOut>): Promise<RouteOut> {
  const before = await fx.state(versionId);
  const r = await write();
  expect(await fx.state(versionId), dump(r)).toEqual(before);
  return r;
}

/** A locked version holding one driver (Rent, fixed), one hire and one override cell, written before the lock. */
async function lockedVersion() {
  const v = await fx.version(w, { status: 'approved' });
  await fx.amount(w, v, w.rent, w.months[0]!, 10);
  const co = { id: w.u.homeCompanyId, user: w.u.userId, acct: w.rent, acct2: w.sales } as never;
  const driverId = String((await insertDriver(pool, co, v, { acct: w.rent, from: `${w.months[0]}-01`, to: `${w.months[11]}-01` })).rows[0].id);
  await pool.query(`UPDATE budget_month_amounts SET amount_source = 'override' WHERE version_id = $1`, [v]);
  const hireId = String((await pool.query(
    `INSERT INTO budget_planned_hires (company_id, version_id, label, start_month, created_by) VALUES ($1, $2, 'Clerk', $3, $4) RETURNING id`,
    [w.u.homeCompanyId, v, `${w.months[2]}-01`, w.u.userId])).rows[0].id);
  await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [v, w.u.userId]);
  return { v, driverId, hireId };
}

describe('budget driver writes: a locked version', () => {
  it('refuses every write 409 BUDGET_VERSION_LOCKED and writes nothing', async () => {
    const { v, driverId, hireId } = await lockedVersion();
    const hire = { versionId: v, label: 'Analyst', startMonth: w.months[3] };
    const writes: Array<[string, () => Promise<RouteOut>]> = [
      ['driver save', () => fx.call.drivers(w.u, 'PUT', fixed(v, w.sales))],
      ['driver replace', () => fx.call.drivers(w.u, 'PUT', fixed(v, w.rent, { amount: 99 }))],
      ['driver delete', () => fx.call.drivers(w.u, 'DELETE', undefined, { versionId: v, id: driverId })],
      ['reset override', () => fx.call.override(w.u, { versionId: v, glAccountId: w.rent })],
      ['headcount refresh', () => fx.call.headcount(w.u, 'POST', { versionId: v })],
      ['hire create', () => fx.call.hires(w.u, 'POST', hire)],
      ['hire update', () => fx.call.hires(w.u, 'PUT', { ...hire, id: hireId })],
      ['hire delete', () => fx.call.hires(w.u, 'DELETE', undefined, { versionId: v, id: hireId })],
    ];
    for (const [what, write] of writes) {
      const r = await refused(v, write);
      expect([r.status, errCode(r)], `${what}: ${dump(r)}`).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    }
  });

  it('takes the lock before it checks what the driver names: a foreign account on a locked version is still 409', async () => {
    const { v } = await lockedVersion();
    const r = await refused(v, () => fx.call.drivers(w.u, 'PUT', fixed(v, other.sales)));
    expect([r.status, errCode(r)], dump(r)).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    const h = await refused(v, () => fx.call.hires(w.u, 'POST', { versionId: v, label: 'X', startMonth: '1999-01' }));
    expect([h.status, errCode(h)], dump(h)).toEqual([409, 'BUDGET_VERSION_LOCKED']);
  });

  it('reads stay open on a locked version', async () => {
    const { v } = await lockedVersion();
    expect((await fx.call.drivers(viewer, 'GET', undefined, { versionId: v })).status).toBe(200);
    expect((await fx.call.hires(viewer, 'GET', undefined, { versionId: v })).status).toBe(200);
    expect((await fx.call.headcount(viewer, 'GET', undefined, { versionId: v })).status).toBe(200);
  });

  it('a viewer reads headcount at company and cost-centre scope (viewers read budgets, decision 15)', async () => {
    const { v } = await lockedVersion();
    const cc = await fx.call.headcount(viewer, 'GET', undefined, { versionId: v, costCentreId: w.cc1 });
    expect(cc.status, dump(cc)).toBe(200);
    expect(dataOf<{ costCentreId: string }>(cc).costCentreId).toBe(w.cc1);
  });
});

describe('budget driver writes: cycles and references', () => {
  it('a driver that closes a loop is 400 DRIVER_CYCLE with the path, and nothing is written', async () => {
    const v = await fx.version(w);
    const first = await fx.call.drivers(w.u, 'PUT', pctOf(v, w.cogs, w.sales));
    expect(first.status, dump(first)).toBe(200);
    const r = await refused(v, () => fx.call.drivers(w.u, 'PUT', pctOf(v, w.sales, w.cogs)));
    expect([r.status, details(r).code], dump(r)).toEqual([400, 'DRIVER_CYCLE']);
    const path = details(r).path as string[];
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path.map((k) => k.split('|')[0]))).toEqual(new Set([w.sales, w.cogs]));
    expect(String(r.body.error?.message)).toMatch(/GS-4000 Sales.*GS-5100 Cost of sales|GS-5100 Cost of sales.*GS-4000 Sales/);
  });

  it('a row in the section it reads is a cycle too', async () => {
    const v = await fx.version(w);
    const r = await refused(v, () => fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_section', pct: 5, section: 'cost_of_sales', scope: 'company',
      fromMonth: w.months[0], toMonth: w.months[1],
    }));
    expect([r.status, details(r).code], dump(r)).toEqual([400, 'DRIVER_CYCLE']);
    expect(details(r).path).toEqual([`${w.cogs}|||`, `${w.cogs}|||`]);
  });

  it('months outside the version, a growth base on or after the start, a percent past NUMERIC(9,4): 400 DRIVER_REF; part cents DRIVER_RANGE', async () => {
    const v = await fx.version(w);
    const outside = await refused(v, () => fx.call.drivers(w.u, 'PUT', fixed(v, w.rent, { toMonth: '2099-01' })));
    expect([outside.status, details(outside).code], dump(outside)).toEqual([400, 'DRIVER_REF']);
    const base = await refused(v, () => fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'growth', pct: 2, baseMonth: w.months[3], fromMonth: w.months[3], toMonth: w.months[5],
    }));
    expect([base.status, details(base).code], dump(base)).toEqual([400, 'DRIVER_REF']);
    const pct = await refused(v, () => fx.call.drivers(w.u, 'PUT', { ...pctOf(v, w.cogs, w.sales), pct: 100000 }));
    expect([pct.status, details(pct).code], dump(pct)).toEqual([400, 'DRIVER_REF']);
    const range = await refused(v, () => fx.call.drivers(w.u, 'PUT', fixed(v, w.rent, { amount: 0.001 })));
    expect([range.status, details(range).code], dump(range)).toEqual([400, 'DRIVER_RANGE']);
  });

  it("another company's version is 404; its account, centre or a header / inactive / asset account is 400; nothing is written", async () => {
    const theirs = await fx.version(other);
    const r404 = await refused(theirs, () => fx.call.drivers(w.u, 'PUT', fixed(theirs, other.rent)));
    expect([r404.status, errCode(r404)], dump(r404)).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
    const v = await fx.version(w);
    const bad: Array<Record<string, unknown>> = [
      fixed(v, other.rent), fixed(v, w.rent, { cc1Id: other.cc1 }), fixed(v, w.rent, { cc1Id: w.cc2 }), fixed(v, w.header),
      fixed(v, w.inactive), fixed(v, w.asset), pctOf(v, w.cogs, other.sales),
      { ...fixed(v, w.rent), kind: 'per_head', headcountCostCentreId: other.cc1 },
    ];
    for (const body of bad) {
      const r = await refused(v, () => fx.call.drivers(w.u, 'PUT', body));
      expect([r.status, errCode(r)], `${JSON.stringify(body)} ${dump(r)}`).toEqual([400, 'BUDGET_VERSION_INPUT']);
    }
  });

  it('a grid save at another grain than the account driver is 400 BUDGET_GRAIN_CONFLICT, nothing written', async () => {
    const v = await fx.version(w);
    const put = await fx.call.drivers(w.u, 'PUT', { ...fixed(v, w.rent), fromMonth: w.months[0], toMonth: w.months[0] });
    expect(put.status, dump(put)).toBe(200);
    // The driver's company-level cell is typed over (an override), then cleared in the batch (a reset), so
    // only the 949 trigger (an amount at another grain than the account's driver) stands in the way.
    expect((await fx.call.save(w.u, v, [{ glAccountId: w.rent, cc1Id: null, cc2Id: null, buId: null, month: w.months[0], amount: 7 }])).status).toBe(200);
    const r = await refused(v, () => fx.call.save(w.u, v, [
      { glAccountId: w.rent, cc1Id: null, cc2Id: null, buId: null, month: w.months[0], amount: null, clear: true },
      { glAccountId: w.rent, cc1Id: w.cc1, cc2Id: null, buId: null, month: w.months[1], amount: 5 },
    ]));
    expect([r.status, errCode(r)], dump(r)).toEqual([400, 'BUDGET_GRAIN_CONFLICT']);
    // The trigger's answer (budgetDbRefusal), not the service's own amounts-only check.
    expect(String(r.body.error?.message)).toBe('An account is budgeted at one level per version: company level or one dimension');
  });

  it('a driver or planned hire this version does not hold is 404 DRIVER_NOT_FOUND / PLANNED_HIRE_NOT_FOUND', async () => {
    const v = await fx.version(w);
    const theirs = await fx.version(other);
    const theirDriver = dataOf<{ driver: { id: string } }>(await fx.call.drivers(other.u, 'PUT', fixed(theirs, other.rent))).driver.id;
    const gone = crypto.randomUUID();
    for (const id of [gone, theirDriver]) {
      const r = await refused(v, () => fx.call.drivers(w.u, 'DELETE', undefined, { versionId: v, id }));
      expect([r.status, errCode(r)], dump(r)).toEqual([404, 'DRIVER_NOT_FOUND']);
    }
    const put = await refused(v, () => fx.call.hires(w.u, 'PUT', { versionId: v, id: gone, label: 'X', startMonth: w.months[1] }));
    expect([put.status, errCode(put)], dump(put)).toEqual([404, 'PLANNED_HIRE_NOT_FOUND']);
    const del = await refused(v, () => fx.call.hires(w.u, 'DELETE', undefined, { versionId: v, id: gone }));
    expect([del.status, errCode(del)], dump(del)).toEqual([404, 'PLANNED_HIRE_NOT_FOUND']);
  });

  it('a viewer is 403 and nothing is written', async () => {
    const v = await fx.version(w);
    const r = await refused(v, () => fx.call.drivers(viewer, 'PUT', fixed(v, w.rent)));
    expect(r.status).toBe(403);
  });
});

describe('budget driver writes: the token', () => {
  it('a stale or missing token is refused (409 BUDGET_VERSION_STALE with the current token and status; 422 / 400) and nothing is written', async () => {
    const v = await fx.version(w, { status: 'approved' });
    const stale = await fx.token(v);
    const seeded = await fx.call.drivers(w.u, 'PUT', fixed(v, w.rent));
    const hireId = dataOf<{ hire: { id: string } }>(await fx.call.hires(w.u, 'POST', { versionId: v, label: 'Clerk', startMonth: w.months[2] })).hire.id;
    const driverId = dataOf<{ driver: { id: string } }>(seeded).driver.id;
    const current = await fx.token(v);
    const hire = { versionId: v, expectedUpdatedAt: stale, label: 'Analyst', startMonth: w.months[3] };
    const writes: Array<[string, () => Promise<RouteOut>]> = [
      ['driver save', () => fx.call.drivers(w.u, 'PUT', { ...fixed(v, w.sales), expectedUpdatedAt: stale })],
      ['driver delete', () => fx.call.drivers(w.u, 'DELETE', undefined, { versionId: v, id: driverId, expectedUpdatedAt: stale })],
      ['reset override', () => fx.call.override(w.u, { versionId: v, expectedUpdatedAt: stale, glAccountId: w.rent })],
      ['headcount refresh', () => fx.call.headcount(w.u, 'POST', { versionId: v, expectedUpdatedAt: stale })],
      ['hire create', () => fx.call.hires(w.u, 'POST', hire)],
      ['hire update', () => fx.call.hires(w.u, 'PUT', { ...hire, id: hireId })],
      ['hire delete', () => fx.call.hires(w.u, 'DELETE', undefined, { versionId: v, id: hireId, expectedUpdatedAt: stale })],
    ];
    for (const [what, write] of writes) {
      const r = await refused(v, write);
      expect([r.status, errCode(r)], `${what}: ${dump(r)}`).toEqual([409, 'BUDGET_VERSION_STALE']);
      expect(details(r), what).toMatchObject({ currentUpdatedAt: current, status: 'approved' });
    }
    const missing = await refused(v, () => fx.call.drivers(w.u, 'PUT', { ...fixed(v, w.sales), expectedUpdatedAt: undefined }));
    expect(missing.status, dump(missing)).toBe(422);
    const missingQuery = await refused(v, () => fx.call.hires(w.u, 'DELETE', undefined, { versionId: v, id: hireId, expectedUpdatedAt: '' }));
    expect(missingQuery.status, dump(missingQuery)).toBe(400);
  });

  it('a successful write moves the version token and answers the new one; the grid save accepts it', async () => {
    const v = await fx.version(w);
    const old = await fx.token(v);
    const r = await fx.call.drivers(w.u, 'PUT', fixed(v, w.rent));
    expect(r.status, dump(r)).toBe(200);
    const { updatedAt } = dataOf<{ updatedAt: string }>(r);
    expect(updatedAt).not.toBe(old);
    expect(updatedAt).toBe(await fx.token(v));
    const hire = await fx.call.hires(w.u, 'POST', { versionId: v, label: '  Sales rep  ', startMonth: w.months[1], fte: 0.5 });
    expect(hire.status, dump(hire)).toBe(200);
    expect(dataOf<{ hire: { label: string; fte: number } }>(hire).hire).toMatchObject({ label: 'Sales rep', fte: 0.5 });
    expect(dataOf<{ updatedAt: string }>(hire).updatedAt).not.toBe(updatedAt);
  });

  it('a planned hire moves a per_head row: R1 000 a head × (0 payroll + 1.5 hired) = R1 500', async () => {
    const v = await fx.version(w);
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'per_head', amount: 1000, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect(put.status, dump(put)).toBe(200);
    expect((await fx.row(v, w.rent)).get(w.months[4]!)).toMatchObject({ amount: '0.00', source: 'driver' });
    const a = await fx.call.hires(w.u, 'POST', { versionId: v, label: 'Clerk', startMonth: w.months[4], fte: 1 });
    const b = await fx.call.hires(w.u, 'POST', { versionId: v, label: 'Intern', startMonth: w.months[4], endMonth: w.months[4], fte: 0.5 });
    expect([a.status, b.status], `${dump(a)} ${dump(b)}`).toEqual([200, 200]);
    const rent = await fx.row(v, w.rent);
    expect(rent.get(w.months[3]!)!.amount).toBe('0.00');
    expect(rent.get(w.months[4]!)!.amount).toBe('1500.00');
    expect(rent.get(w.months[5]!)!.amount).toBe('1000.00');
    const del = await fx.call.hires(w.u, 'DELETE', undefined, { versionId: v, id: dataOf<{ hire: { id: string } }>(a).hire.id });
    expect(del.status, dump(del)).toBe(200);
    expect((await fx.row(v, w.rent)).get(w.months[5]!)!.amount).toBe('0.00');
    const audits = (await fx.audits(v)).map((x) => x.changes.metadata?.driverAction);
    expect(audits).toEqual(['driver_saved', 'hire_created', 'hire_created', 'hire_deleted']);
  });
});
