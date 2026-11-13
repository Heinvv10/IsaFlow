/**
 * Budgets P6 PR C (spec §7, §10 I8 I9, §13 items 18-21), real PostgreSQL through PUT
 * /budget-three-way/assumptions as real members: the row's own `updated_at` is the token (null = no row
 * yet), a save never bumps the version's token, one audit row per save with before/after per section,
 * stale → 409 { code, currentUpdatedAt }, locked → 409 BUDGET_VERSION_LOCKED (I9), overrides only on a
 * scenario whose chain resolves (a cross-year base refused AFTER the write: the savepoint takes it back),
 * two racing saves with one token → one 200 and one 409, never a 5xx, and an empty override = its base (I8).
 * Every refusal is checked to leave the row, its token and the audit trail exactly as they were.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, code, dataOf, details, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');

const fullDoc = (debtorDays = 45) => {
  const d = defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
  d.workingCapital.debtorDays = { value: debtorDays, source: 'manual' };
  return d;
};
const tokenOf = (r: RouteOut) => String((r.body.data as { updatedAt: string }).updatedAt);
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 400);

let A: ThreeWayCo;

beforeAll(async () => {
  A = await fx.company();
}, 60000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('save: the row token, the version token, the audit row', () => {
  let v: string;
  let first: RouteOut;
  beforeAll(async () => {
    v = await fx.version(A, { kind: 'reforecast' });
  });

  it('the first save (token null) inserts, answers the row token and leaves the version token alone', async () => {
    const before = await fx.state(v);
    first = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(45), expected_updated_at: null });
    expect(first.status, dump(first)).toBe(200);
    const after = await fx.state(v);
    expect(tokenOf(first)).toBe(after.row.token);
    expect(after.row.updated_by).toBe(A.owner.userId);
    expect(after.versionToken).toBe(before.versionToken);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]!.action).toBe('create');
    expect(after.audits[0]!.changes.metadata).toMatchObject({ threeWayAction: 'assumptions', document: 'full', fiscalYear: '2027' });
    const wc = after.audits[0]!.changes.fields.find((f) => f.field === 'threeWay.workingCapital');
    expect(wc?.old).toBeNull();
    expect(JSON.parse(String(wc?.new))).toMatchObject({ debtorDays: { value: 45 } });
  });

  it('a save with that token updates; the audit row names only what changed, before and after', async () => {
    const r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(60), expected_updated_at: tokenOf(first) });
    expect(r.status, dump(r)).toBe(200);
    expect(tokenOf(r)).not.toBe(tokenOf(first));
    const s = await fx.state(v);
    expect(s.audits).toHaveLength(2);
    expect(s.audits[1]!.action).toBe('update');
    expect(s.audits[1]!.changes.fields.map((f) => f.field)).toEqual(['threeWay.workingCapital']);
    const f = s.audits[1]!.changes.fields[0]!;
    expect(JSON.parse(String(f.old)).debtorDays.value).toBe(45);
    expect(JSON.parse(String(f.new)).debtorDays.value).toBe(60);
  });

  it('the old token, a null token over a row, and a token over no row are 409 STALE; nothing changes', async () => {
    const before = await fx.state(v);
    const stale = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(90), expected_updated_at: tokenOf(first) });
    expect(stale.status).toBe(409);
    expect(details(stale)).toEqual({ code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: before.row.token });
    const nullOverRow = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(90), expected_updated_at: null });
    expect(details(nullOverRow)).toEqual({ code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: before.row.token });
    expect(await fx.state(v)).toEqual(before);

    const fresh = await fx.version(A, { kind: 'reforecast' });
    const ghost = await fx.routes.put(A.owner, { version_id: fresh, doc: fullDoc(), expected_updated_at: before.row.token });
    expect(ghost.status).toBe(409);
    expect(details(ghost)).toEqual({ code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: null });
    expect((await fx.state(fresh)).row).toBeNull();
    expect((await fx.state(fresh)).audits).toHaveLength(0);
  });
});

describe('the token is the DB text to the microsecond (never a JS Date)', () => {
  it('answers 6 fractional digits equal to updated_at, and a millisecond-truncated token is 409 STALE', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    let r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(10), expected_updated_at: null });
    expect(r.status, dump(r)).toBe(200);
    // A token whose microseconds are a whole millisecond survives a Date round trip: save again until it is not.
    for (let i = 0; i < 5 && tokenOf(r).slice(23, 26) === '000'; i++) {
      r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(11 + i), expected_updated_at: tokenOf(r) });
    }
    const token = tokenOf(r);
    expect(token).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(token.slice(23, 26)).not.toBe('000');
    const same = (await pool.query(
      `SELECT updated_at = $2::TIMESTAMPTZ AS same, updated_at = $3::TIMESTAMPTZ AS ms FROM budget_three_way_assumptions WHERE version_id = $1`,
      [v, token, new Date(token).toISOString()])).rows[0];
    expect(same).toEqual({ same: true, ms: false });

    const before = await fx.state(v);
    const truncated = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(99), expected_updated_at: new Date(token).toISOString() });
    expect(truncated.status).toBe(409);
    expect(details(truncated)).toEqual({ code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: token });
    expect(await fx.state(v)).toEqual(before);
    // Postgres' own spelling of the same instant is accepted (compared as timestamptz in SQL).
    const pgText = String((await pool.query(`SELECT updated_at::text AS t FROM budget_three_way_assumptions WHERE version_id = $1`, [v])).rows[0].t);
    const ok = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(98), expected_updated_at: pgText });
    expect(ok.status, dump(ok)).toBe(200);
    expect(tokenOf(ok)).not.toBe(token);
  });
});

describe('I9: a locked version refuses assumption writes', () => {
  it('409 BUDGET_VERSION_LOCKED, nothing written, no audit row', async () => {
    const v = await fx.version(A, { kind: 'reforecast', status: 'locked' });
    const before = await fx.state(v); // the status moves' own audit rows (DB trigger)
    const r = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null });
    expect(r.status).toBe(409);
    expect(code(r)).toBe('BUDGET_VERSION_LOCKED');
    const s = await fx.state(v);
    expect(s.row).toBeNull();
    expect(s).toEqual(before);
    // Reads still work on a locked version.
    expect((await fx.routes.index(A.owner, { version_id: v })).status).toBe(200);
  });
});

describe('scenarios (§13.21)', () => {
  it('overrides on a non-scenario are 400 OVERRIDES_ON_NON_SCENARIO; nothing written', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    const r = await fx.routes.put(A.owner, { version_id: v, doc: { schemaVersion: 1, overrides: {} }, expected_updated_at: null });
    expect(r.status).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_SCENARIO_CHAIN', reason: 'OVERRIDES_ON_NON_SCENARIO' });
    expect((await fx.state(v)).row).toBeNull();
  });

  it('overrides over a base in another year are refused after the write: the savepoint takes the row and audit back', async () => {
    const base2026 = await fx.version(A, { fy: 2026, kind: 'original' });
    const s = await fx.version(A, { kind: 'scenario', basedOn: base2026 });
    const r = await fx.routes.put(A.owner, {
      version_id: s, doc: { schemaVersion: 1, overrides: { minimumCash: { value: 100, source: 'manual' } } }, expected_updated_at: null,
    });
    expect(r.status, dump(r)).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_SCENARIO_CHAIN', reason: 'CROSS_YEAR' });
    const st = await fx.state(s);
    expect(st.row).toBeNull();
    expect(st.audits).toHaveLength(0);
    // The same scenario can still store a full document.
    const full = await fx.routes.put(A.owner, { version_id: s, doc: fullDoc(), expected_updated_at: null });
    expect(full.status, dump(full)).toBe(200);
  });

  it('I8: an empty override is its base, figures and all; a one-field override changes that field only', async () => {
    const base = await fx.version(A, { kind: 'reforecast' });
    const empty = await fx.version(A, { kind: 'scenario', basedOn: base });
    const worse = await fx.version(A, { kind: 'scenario', basedOn: base });
    for (const v of [base, empty, worse]) {
      await fx.amounts(A, v, A.acct.sales, FY, 20000);
      await fx.amounts(A, v, A.acct.rent, FY, 5000);
    }
    expect((await fx.routes.put(A.owner, { version_id: base, doc: fullDoc(30), expected_updated_at: null })).status).toBe(200);
    expect((await fx.routes.put(A.owner, { version_id: empty, doc: { schemaVersion: 1, overrides: {} }, expected_updated_at: null })).status).toBe(200);
    const over = { schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 90, source: 'manual' } } } };
    expect((await fx.routes.put(A.owner, { version_id: worse, doc: over, expected_updated_at: null })).status).toBe(200);

    const view = async (v: string) => {
      const r = await fx.routes.index(A.owner, { version_id: v });
      expect(r.status, dump(r)).toBe(200);
      return dataOf<ThreeWayView>(r);
    };
    const [b, e, w] = [await view(base), await view(empty), await view(worse)];
    expect(e.assumptions.resolved).toEqual(b.assumptions.resolved);
    expect(e.assumptions.chain).toEqual([empty, base]);
    expect(e.balanceSheet).toEqual(b.balanceSheet);
    expect(e.cashFlow).toEqual(b.cashFlow);
    expect(w.assumptions.resolved.workingCapital.debtorDays).toEqual({ value: 90, source: 'manual' });
    expect({ ...w.assumptions.resolved, workingCapital: b.assumptions.resolved.workingCapital }).toEqual(b.assumptions.resolved);
    expect(w.balanceSheet[2]!.closing.receivables).toBeGreaterThan(b.balanceSheet[2]!.closing.receivables);
  });
});

describe('concurrency', () => {
  it('two saves with one token: one 200, one 409 STALE, never a 5xx; one row, one audit row', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    const results = await Promise.all([
      fx.routes.put(A.owner, { version_id: v, doc: fullDoc(11), expected_updated_at: null }),
      fx.routes.put(A.owner, { version_id: v, doc: fullDoc(22), expected_updated_at: null }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    const s = await fx.state(v);
    expect(details(loser)).toEqual({ code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: s.row.token });
    expect(s.audits).toHaveLength(1);
    const winner = results.find((r) => r.status === 200)!;
    expect(s.row.doc.workingCapital.debtorDays.value).toBe((winner.body.data as { doc: { workingCapital: { debtorDays: { value: number } } } }).doc.workingCapital.debtorDays.value);

    const t = s.row.token;
    const again = await Promise.all([
      fx.routes.put(A.owner, { version_id: v, doc: fullDoc(33), expected_updated_at: t }),
      fx.routes.put(A.owner, { version_id: v, doc: fullDoc(44), expected_updated_at: t }),
    ]);
    expect(again.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await fx.state(v)).audits).toHaveLength(2);
  });
});
