/**
 * Budgets P6 PR C (spec §7, §10 I10, §13.13), real PostgreSQL through the real routes (withAuth,
 * request transaction, CSRF, role gate): the dark flag (403 without it), input refusals (422 shape,
 * 400 document), write roles, tenant isolation (I10: another company's version is 404 with no data,
 * through every route and through the service on a connection that bypasses RLS), and compare
 * (1-3 versions, one fiscal year, Δ vs the first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { readChain } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { getAssumptionsView, type CompareView, type ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { monthsFrom } from './helpers/budgetGridFixture';
import { budgetThreeWayFixture, code, dataOf, details, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetThreeWayFixture(pool);
const FY = monthsFrom('2026-03');

const fullDoc = (debtorDays = 45) => {
  const d = defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
  d.workingCapital.debtorDays = { value: debtorDays, source: 'manual' };
  return d;
};

let A: ThreeWayCo, B: ThreeWayCo, Off: ThreeWayCo;
let vA: string, vA2: string, vB: string, vOff: string, vA2028: string;

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  Off = await fx.company({ flag: false });
  vA = await fx.version(A, { kind: 'original', primary: true, name: 'A plan' });
  vA2 = await fx.version(A, { kind: 'scenario', basedOn: vA, name: 'A worst' });
  vA2028 = await fx.version(A, { fy: 2028, kind: 'original', name: 'A next' });
  vB = await fx.version(B, { kind: 'original' });
  vOff = await fx.version(Off, { kind: 'original' });
  await fx.amounts(A, vA, A.acct.sales, FY, 10000);
  await fx.amounts(A, vA2, A.acct.sales, FY, 6000);
  const saved = await fx.routes.put(A.owner, { version_id: vA, doc: fullDoc(), expected_updated_at: null });
  if (saved.status !== 200) throw new Error(`seed PUT: ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
}, 120000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('the budgets_three_way flag (§13.13)', () => {
  it('a company without it gets 403 from every route, and nothing is written', async () => {
    expect((await fx.routes.index(Off.owner, { version_id: vOff })).status).toBe(403);
    expect((await fx.routes.getAssumptions(Off.owner, vOff)).status).toBe(403);
    expect((await fx.routes.put(Off.owner, { version_id: vOff, doc: fullDoc(), expected_updated_at: null })).status).toBe(403);
    expect((await fx.routes.derive(Off.owner, { version_id: vOff })).status).toBe(403);
    expect((await fx.routes.compare(Off.owner, vOff)).status).toBe(403);
    expect((await fx.state(vOff)).row).toBeNull();
  });

  it('an override switched off is off again (403), and on again answers 200', async () => {
    await fx.setFlag(A, false);
    expect((await fx.routes.index(A.owner, { version_id: vA })).status).toBe(403);
    await fx.setFlag(A, true);
    expect((await fx.routes.index(A.owner, { version_id: vA })).status).toBe(200);
  });
});

describe('input and roles', () => {
  it('a bad query or body shape is 422; an invalid document 400 with the issue path; nothing written', async () => {
    expect((await fx.routes.index(A.owner, { version_id: 'nope' })).status).toBe(422);
    expect((await fx.routes.getAssumptions(A.owner, 'nope')).status).toBe(422);
    expect((await fx.routes.put(A.owner, { version_id: vA2, doc: fullDoc() })).status).toBe(422);
    expect((await fx.routes.put(A.owner, { version_id: vA2, doc: fullDoc(), expected_updated_at: 'yesterday' })).status).toBe(422);
    const bad = fullDoc();
    (bad.workingCapital.debtorDays as { value: number }).value = 400;
    const r = await fx.routes.put(A.owner, { version_id: vA2, doc: bad, expected_updated_at: null });
    expect(r.status).toBe(400);
    expect(details(r)).toMatchObject({ code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [expect.objectContaining({ path: 'workingCapital.debtorDays.value' })] });
    expect((await fx.state(vA2)).row).toBeNull();
  });

  it('a viewer reads (200) but cannot save (403) or derive (403)', async () => {
    expect((await fx.routes.index(A.viewer, { version_id: vA })).status).toBe(200);
    expect((await fx.routes.getAssumptions(A.viewer, vA)).status).toBe(200);
    expect((await fx.routes.put(A.viewer, { version_id: vA2, doc: fullDoc(), expected_updated_at: null })).status).toBe(403);
    expect((await fx.routes.derive(A.viewer, { version_id: vA })).status).toBe(403);
    expect((await fx.state(vA2)).row).toBeNull();
  });

  it('no version_id reads the primary of ?fiscal_year=; a year with none is 404', async () => {
    const r = await fx.routes.index(A.owner, { fiscal_year: '2027' });
    expect(r.status).toBe(200);
    expect(dataOf<ThreeWayView>(r).version.id).toBe(vA);
    expect(code(await fx.routes.index(A.owner, { fiscal_year: '2028' }))).toBe('BUDGET_VERSION_NOT_FOUND');
  });
});

describe('I10: another company’s version is 404 with no data', () => {
  it('through every route', async () => {
    for (const r of [
      await fx.routes.index(B.owner, { version_id: vA }),
      await fx.routes.getAssumptions(B.owner, vA),
      await fx.routes.put(B.owner, { version_id: vA, doc: fullDoc(9), expected_updated_at: null }),
      await fx.routes.derive(B.owner, { version_id: vA }),
      await fx.routes.compare(B.owner, `${vB},${vA}`),
    ]) {
      expect(r.status).toBe(404);
      expect(code(r)).toBe('BUDGET_VERSION_NOT_FOUND');
      expect(r.body.data).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toContain('"debtorDays"');
    }
    expect((await fx.state(vA)).row.doc.workingCapital.debtorDays.value).toBe(45);
  });

  it('through the service on a connection that bypasses RLS (the company_id predicates alone)', async () => {
    await expect(fx.direct(B, () => readChain(B.id, vA))).rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
    await expect(fx.direct(B, () => getAssumptionsView(B.id, vA, '2026-11-13'))).rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
    const own = await fx.direct(A, () => readChain(A.id, vA));
    expect(own.stored?.doc).toMatchObject({ workingCapital: { debtorDays: { value: 45 } } });
  });
});

describe('compare', () => {
  it('two versions of one year: series, Δ vs the first, KPIs', async () => {
    const r = await fx.routes.compare(A.owner, `${vA},${vA2}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const c = dataOf<CompareView>(r);
    expect(c.fiscalYear).toBe(2027);
    expect(c.months).toEqual(FY);
    expect(c.versions.map((v) => v.versionId)).toEqual([vA, vA2]);
    expect(c.versions[0]!.cashDelta.every((d) => d === 0)).toBe(true);
    expect(c.versions[1]!.kpis.netProfit).toMatchObject({ value: 12 * 600000, delta: -12 * 400000, favourable: false });
  });

  it('versions of different years are 400; more than three or none are 422', async () => {
    const r = await fx.routes.compare(A.owner, `${vA},${vA2028}`);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('BUDGET_THREE_WAY_INPUT');
    expect((await fx.routes.compare(A.owner, '')).status).toBe(422);
    const four = [vA, vA2, vA2028, crypto.randomUUID()].join(',');
    expect((await fx.routes.compare(A.owner, four)).status).toBe(422);
  });
});
