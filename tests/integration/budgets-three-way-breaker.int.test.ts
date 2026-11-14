/** Adversarial repros (breaker). ci-integration-skip: never (throwaway). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { saveAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { getThreeWay, compareView, getAssumptionsView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, code, dataOf, type RouteOut, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const dump = (r: RouteOut) => JSON.stringify(r.body).slice(0, 600);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
const tokenOf = (r: RouteOut) => String((r.body.data as { updatedAt: string }).updatedAt);

let A: ThreeWayCo, B: ThreeWayCo;
let vA: string, vB: string, sA: string;
let taxA: string, taxB: string, vatA: string;

const liability = async (c: ThreeWayCo, code: string, name: string, subtype: string | null = null) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
   VALUES ($1, $2, $3, 'liability', $4, 'credit', 3, true) RETURNING id`, [c.id, code, name, subtype])).rows[0].id);

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  vA = await fx.version(A, { kind: 'reforecast' });
  vB = await fx.version(B, { kind: 'reforecast' });
  sA = await fx.version(A, { kind: 'scenario', basedOn: vA });
  taxA = await liability(A, '2300', 'Income tax payable');
  taxB = await liability(B, '2300', 'Income tax payable');
  // 'vat_control' is not a subtype IsaFlow knows (accountSubtypeVocabulary has no such spelling; the VAT201
  // membership reads vat_input / vat_output), so an account spelled that way is an unmapped liability like any
  // other. The VAT control account the repro means carries the real spelling.
  vatA = await liability(A, '2200', 'VAT control', 'vat_output');
  // AP control holds R50 000 Cr at the opening.
  await fx.journal(A, '2026-02-10', [{ acct: A.ap, credit: 50000 }]);
  await fx.journal(A, '2026-02-11', [{ acct: vatA, credit: 7000 }]);
}, 90000);

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
});

describe('REPRO 1: a typed control account can be named as income-tax payable', () => {
  it('the AP control account (subtype payable) is refused as incomeTax.payableAccountId', async () => {
    const doc = fullDoc();
    doc.incomeTax.payableAccountId = A.ap;
    const v = await fx.version(A, { kind: 'reforecast' });
    const r = await fx.routes.put(A.owner, { version_id: v, doc, expected_updated_at: null });
    const run = await fx.routes.index(A.owner, { version_id: v });
    const o = dataOf<ThreeWayView>(run).opening;
    process.stderr.write(`R1 put=${r.status} run=${run.status} payables=${o?.buckets.payables} incomeTaxPayable=${o?.buckets.incomeTaxPayable}\n`);
    expect(r.status, dump(r)).toBe(400);
  });
  it('the VAT control account is refused as equity.dividendsPayableAccountId', async () => {
    const doc = fullDoc();
    doc.equity.dividendsPayableAccountId = vatA;
    const v = await fx.version(A, { kind: 'reforecast' });
    const r = await fx.routes.put(A.owner, { version_id: v, doc, expected_updated_at: null });
    const run = await fx.routes.index(A.owner, { version_id: v });
    const o = dataOf<ThreeWayView>(run).opening;
    process.stderr.write(`R1b put=${r.status} run=${run.status} buckets=${JSON.stringify(o?.buckets)}\n`);
    expect(r.status, dump(r)).toBe(400);
  });
});

describe('REPRO 2: base + scenario name the same account; the scenario stores a doc that never runs', () => {
  it('scenario save is accepted but the run 400s', async () => {
    const base = fullDoc();
    base.equity.dividendsPayableAccountId = taxA;
    const b = await fx.routes.put(A.owner, { version_id: vA, doc: base, expected_updated_at: null });
    expect(b.status, dump(b)).toBe(200);
    const s = await fx.routes.put(A.owner, {
      version_id: sA, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: taxA } } }, expected_updated_at: null,
    });
    const run = await fx.routes.index(A.owner, { version_id: sA });
    process.stderr.write(`R2 save=${s.status} run=${run.status} ${code(run)}\n`);
    expect(s.status === 200 && run.status !== 200, `save ${s.status} then run ${run.status}`).toBe(false);
  });
});

describe('held checks', () => {
  it('cross-tenant ids via every route are 404 / 400, nothing leaks', async () => {
    expect((await fx.routes.index(A.owner, { version_id: vB })).status).toBe(404);
    expect((await fx.routes.getAssumptions(A.owner, vB)).status).toBe(404);
    expect((await fx.routes.put(A.owner, { version_id: vB, doc: fullDoc(), expected_updated_at: null })).status).toBe(404);
    expect((await fx.routes.derive(A.owner, { version_id: vB })).status).toBe(404);
    expect((await fx.routes.compare(A.owner, `${vA},${vB}`)).status).toBe(404);
    const d = fullDoc(); d.incomeTax.payableAccountId = taxB;
    const v = await fx.version(A, { kind: 'reforecast' });
    const r = await fx.routes.put(A.owner, { version_id: v, doc: d, expected_updated_at: null });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(B.id);
    expect((await fx.state(vB)).row).toBeNull();
  });

  it('service on the RLS-bypassing connection: other company ids refused', async () => {
    await expect(fx.direct(A, () => saveAssumptions(A.id, A.user, { versionId: vB, doc: fullDoc(), expectedUpdatedAt: null }))).rejects.toThrow(/not found/i);
    await expect(fx.direct(A, () => getThreeWay(A.id, { versionId: vB }, '2026-11-13'))).rejects.toThrow(/not found/i);
    await expect(fx.direct(A, () => compareView(A.id, [vA, vB], '2026-11-13'))).rejects.toThrow(/not found/i);
    await expect(fx.direct(A, () => getAssumptionsView(A.id, vB, '2026-11-13'))).rejects.toThrow(/not found/i);
    const d = fullDoc(); d.loans.existing = [{ loanId: crypto.randomUUID(), include: true }];
    d.incomeTax.payableAccountId = taxB;
    const fresh = await fx.version(A, { kind: 'reforecast' });
    await expect(fx.direct(A, () => saveAssumptions(A.id, A.user, { versionId: fresh, doc: d, expectedUpdatedAt: null }))).rejects.toThrow(/invalid/i);
  });

  it('flag on for B only: A is 403 on every route', async () => {
    await fx.setFlag(A, false);
    try {
      expect((await fx.routes.index(A.owner, { version_id: vA })).status).toBe(403);
      expect((await fx.routes.put(A.owner, { version_id: vA, doc: fullDoc(), expected_updated_at: null })).status).toBe(403);
      expect((await fx.routes.derive(A.owner, { version_id: vA })).status).toBe(403);
      expect((await fx.routes.compare(A.owner, vA)).status).toBe(403);
      expect((await fx.routes.getAssumptions(A.owner, vA)).status).toBe(403);
    } finally { await fx.setFlag(A, true); }
  });

  it('input abuse: proto keys, unicode, giant numbers, deep nesting, junk tokens are 4xx and write nothing', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    const bodies: unknown[] = [
      { version_id: v, doc: JSON.parse('{"__proto__":{"schemaVersion":1},"schemaVersion":1}'), expected_updated_at: null },
      { version_id: v, doc: { ...fullDoc(), constructor: { prototype: { x: 1 } } }, expected_updated_at: null },
      { version_id: v, doc: { ...fullDoc(), minimumCash: 1e300 }, expected_updated_at: null },
      { version_id: v, doc: (() => { const d = fullDoc() as unknown as Record<string, unknown>; let x: unknown = 1; for (let i = 0; i < 3000; i++) x = { a: x }; d.deep = x; return d; })(), expected_updated_at: null },
      { version_id: v, doc: fullDoc(), expected_updated_at: '2026-01-01T00:00:00Z\u0000' },
      { version_id: v, doc: fullDoc(), expected_updated_at: '9999-12-31T23:59:59.999999+15:59' },
      { version_id: v, doc: fullDoc(), expected_updated_at: 'infinity' },
      { version_id: v.toUpperCase(), doc: { schemaVersion: 1, overrides: {} }, expected_updated_at: null },
      { version_id: `${v}‮`, doc: fullDoc(), expected_updated_at: null },
    ];
    for (const b of bodies) {
      const r = await fx.routes.put(A.owner, b);
      expect(r.status, dump(r)).toBeGreaterThanOrEqual(400);
      expect(r.status, dump(r)).toBeLessThan(500);
      expect(JSON.stringify(r.body)).not.toMatch(/relation|column|syntax|SELECT|pg_/i);
    }
    expect((await fx.state(v)).row).toBeNull();
    expect((await fx.state(v)).audits).toHaveLength(0);
  });

  it('stale-token tricks: equivalent offset spelling works only as the same instant; a near token is 409', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    const first = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null });
    expect(first.status).toBe(200);
    const t = tokenOf(first);
    const near = t.replace(/\.(\d{6})Z$/, (_m, us: string) => `.${String((Number(us) + 1) % 1e6).padStart(6, '0')}Z`);
    const r1 = await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: near });
    expect(r1.status).toBe(409);
    const ms = t.replace(/\.(\d{3})\d{3}Z$/, '.$1Z');
    if (ms !== t && !t.endsWith('000Z')) expect((await fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: ms })).status).toBe(409);
    expect((await fx.state(v)).audits).toHaveLength(1);
  });

  it('racing PUTs on the same token: exactly one 200, others 409', async () => {
    const v = await fx.version(A, { kind: 'reforecast' });
    const rs = await Promise.all(Array.from({ length: 5 }, () => fx.routes.put(A.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await fx.state(v)).audits).toHaveLength(1);
  });

  it('GETs and derive write nothing (assumptions row, audit, version token)', async () => {
    const before = await fx.state(vA);
    const auditCount = async () => Number((await pool.query(`SELECT count(*) FROM audit_log WHERE company_id = $1`, [A.id])).rows[0].count);
    const ac = await auditCount();
    await fx.routes.index(A.owner, { version_id: vA });
    await fx.routes.getAssumptions(A.owner, vA);
    await fx.routes.derive(A.owner, { version_id: vA });
    await fx.routes.compare(A.owner, `${vA},${sA}`);
    expect(await fx.state(vA)).toEqual(before);
    expect(await auditCount()).toBe(ac);
  });
});
