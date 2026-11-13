/** Adversarial round 3 (breaker). Throwaway. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { AssumptionsView, CompareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { rawBefore, MAX_BEFORE_RAW_BYTES } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetThreeWayFixture, dataOf, type ThreeWayCo } from './helpers/budgetThreeWayFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetThreeWayFixture(pool);
const fullDoc = () => defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
let A: ThreeWayCo, B: ThreeWayCo;
const liab = async (c: ThreeWayCo, code: string) => String((await pool.query(
  `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active) VALUES ($1,$2,$3,'liability','credit',3,true) RETURNING id`, [c.id, code, `L${code}`])).rows[0].id);
beforeAll(async () => { A = await fx.company(); B = await fx.company(); }, 90000);
afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } });

describe('conflict attribution', () => {
  it('compare: only the conflicted entry carries the warning, in input order both ways; the view reports it', async () => {
    const x = await liab(A, '2800');
    const base = await fx.version(A, { kind: 'reforecast' });
    const sc = await fx.version(A, { kind: 'scenario', basedOn: base });
    expect((await fx.routes.put(A.owner, { version_id: base, doc: fullDoc(), expected_updated_at: null })).status).toBe(200);
    expect((await fx.routes.put(A.owner, { version_id: sc, doc: { schemaVersion: 1, overrides: { incomeTax: { payableAccountId: x } } }, expected_updated_at: null })).status).toBe(200);
    const d = fullDoc(); d.equity.dividendsPayableAccountId = x;
    expect((await fx.routes.put(A.owner, { version_id: base, doc: d, expected_updated_at: String((await fx.state(base)).row.token) })).status).toBe(200);
    for (const ids of [[base, sc], [sc, base]]) {
      const r = await fx.routes.compare(A.owner, ids.join(','));
      expect(r.status).toBe(200);
      const vs = dataOf<CompareView>(r).versions;
      for (const v of vs) {
        const has = v.warnings.some((w) => w.code === 'payable_account_conflict');
        expect(has, `${v.versionId === sc ? 'scenario' : 'base'} entry`).toBe(v.versionId === sc);
      }
      expect(vs.map((v) => v.versionId)).toEqual(ids);
    }
    expect(dataOf<AssumptionsView>(await fx.routes.getAssumptions(A.owner, sc)).warnings.map((w) => w.code)).toEqual(['payable_account_conflict']);
    expect(dataOf<AssumptionsView>(await fx.routes.getAssumptions(A.owner, base)).warnings).toEqual([]);
  });
});

describe('beforeRaw', () => {
  it('cut on a character boundary, never over the cap, flagged; small text kept whole', () => {
    for (const ch of ['a', 'é', '€', '😀']) {
      for (let pad = 0; pad < 4; pad++) {
        const raw = 'x'.repeat(pad) + ch.repeat(MAX_BEFORE_RAW_BYTES);
        const r = rawBefore(raw);
        expect(Buffer.byteLength(r.beforeRaw!, 'utf8')).toBeLessThanOrEqual(MAX_BEFORE_RAW_BYTES);
        expect(r.beforeRaw).not.toMatch(/�/);
        expect(raw.startsWith(r.beforeRaw!)).toBe(true);
        expect(r.beforeRawTruncated).toBe(Buffer.byteLength(raw, 'utf8') > MAX_BEFORE_RAW_BYTES ? 'true' : undefined);
        if (r.beforeRawTruncated) expect(Buffer.byteLength(r.beforeRaw!, 'utf8')).toBeGreaterThan(MAX_BEFORE_RAW_BYTES - 4);
      }
    }
    expect(rawBefore('{"a":1}')).toEqual({ beforeInvalid: 'true', beforeRaw: '{"a":1}' });
  });
  it('a large invalid doc and another tenant: audit row capped, only this company\'s text', async () => {
    const vA = await fx.version(A, { kind: 'reforecast' });
    const vB = await fx.version(B, { kind: 'reforecast' });
    for (const [c, v] of [[A, vA], [B, vB]] as const) expect((await fx.routes.put(c.owner, { version_id: v, doc: fullDoc(), expected_updated_at: null })).status).toBe(200);
    await pool.query(`UPDATE budget_three_way_assumptions SET doc = jsonb_build_object('schemaVersion', 1, 'junk', repeat('€', 200000)) WHERE version_id = $1`, [vA]);
    await pool.query(`UPDATE budget_three_way_assumptions SET doc = '{"schemaVersion":1,"secretB":"TENANT-B-DATA"}' WHERE version_id = $1`, [vB]);
    const r = await fx.routes.put(A.owner, { version_id: vA, doc: fullDoc(), expected_updated_at: String((await fx.state(vA)).row.token) });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT changes::TEXT AS t, octet_length(changes::TEXT) AS n FROM audit_log WHERE entity_type='budget' AND entity_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [vA])).rows[0];
    process.stderr.write(`R audit bytes=${row.n}\n`);
    expect(Number(row.n)).toBeLessThan(MAX_BEFORE_RAW_BYTES + 32 * 1024);
    expect(row.t).toContain('beforeRawTruncated');
    expect(row.t).not.toContain('TENANT-B-DATA');
  });
});
