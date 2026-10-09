/**
 * R-035 N1b (B, migration 881): two behaviours the definers own that no
 * other suite reaches.
 *
 *  - The switch-on baseline now lives in approval_enforcement_set. A switcher
 *    who set a supplier's current bank details still switches the control on;
 *    that supplier is left unverified and every other one baselined. (Were it
 *    included, the 876 guard would refuse the whole switch-on.)
 *  - approval_rule_update locks the rule before it judges it, so a raw caller
 *    racing a stricter edit is judged against the rule as it will be written:
 *    an admin's deactivation that waits behind an owner raising the rule from
 *    manager to admin is refused (RB002), never applied to the admin rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, newCompany, plantRule } from './r035-approval.helpers';
import { cleanupPr5, plantSupplier } from './r035-pr5.helpers';
import { bankCompany, bankRoutes, verificationsOf } from './supplier-bank-verification.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '' };
const r = bankRoutes(pool, tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

describe('the switch-on baseline, inside approval_enforcement_set', () => {
  it("baselines every supplier but the ones whose current details the switcher set — and the switch-on succeeds", async () => {
    const { company: c } = await bankCompany(pool, [[u.owner, 'owner']], companies);
    const mine = await plantSupplier(pool, c);
    const theirs = await plantSupplier(pool, c);
    await pool.query('UPDATE suppliers SET bank_details_setters = ARRAY[$1::UUID] WHERE id = $2', [u.owner, mine]);
    const on = await r.toggle(u.owner, c, true);
    expect(on.state.statusCode, JSON.stringify(on.state.body)).toBe(200);
    expect(await verificationsOf(pool, mine)).toEqual([]);
    expect((await verificationsOf(pool, theirs)).map((x) => [x.kind, x.verified_by])).toEqual([['baseline', u.owner]]);
    const { rows } = await pool.query(`SELECT changes->'metadata'->>'baselineSuppliers' AS n FROM audit_log
      WHERE company_id = $1 AND entity_type = 'approval_enforcement' AND action = 'create'`, [c]);
    expect(rows).toEqual([{ n: '1' }]);
  });
});

/** A client inside a transaction as app_user, under `sub`'s claims in `company`. */
async function asUser(sub: string, company: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, session_id: crypto.randomUUID() })]);
  await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  await c.query('SET LOCAL ROLE app_user');
  return c;
}

/** Waits until backend `pid` is blocked on a lock. */
async function blocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
    if (rows.length) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`backend ${pid} never blocked`);
}

describe('approval_rule_update judges the rule under its own lock', () => {
  it("an admin's deactivation queued behind an owner raising the rule to admin is refused (RB002), not applied", async () => {
    const c = await newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin']], companies);
    const rule = await plantRule(pool, c, 'manager', { operator: 'greater_than', value: 1000 });
    const owner = await asUser(u.owner, c);
    const admin = await asUser(u.admin, c);
    try {
      await owner.query('SELECT * FROM approval_rule_update($1,$2,$3,NULL,NULL,NULL,NULL,$4,NULL)', [c, rule, u.owner, 'admin']);
      const pid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const deactivate = admin.query('SELECT * FROM approval_rule_update($1,$2,$3,NULL,NULL,NULL,NULL,NULL,false)', [c, rule, u.admin])
        .then(() => 'applied', (e: { code?: string }) => e.code ?? 'error');
      await blocked(pid);
      await owner.query('COMMIT');
      expect(await deactivate).toBe('RB002');
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
      await owner.query('ROLLBACK').catch(() => undefined);
      admin.release();
      owner.release();
    }
    const { rows: [now] } = await pool.query('SELECT approver_role, is_active FROM approval_rules WHERE id = $1', [rule]);
    expect(now).toEqual({ approver_role: 'admin', is_active: true });
  });
});
