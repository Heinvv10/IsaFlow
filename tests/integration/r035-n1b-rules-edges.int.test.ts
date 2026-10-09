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
import { asRole, outcome } from './r035-n1.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';

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

const SWITCH = 'SELECT * FROM approval_enforcement_set($1,$2,$3,$4)';
const bankSwitch = (c: string, who: string, on: boolean | null) => asRole(pool, 'app_user', c, { sub: who },
  (cl) => cl.query(SWITCH, [c, 'supplier_bank_details', on, who]), true);
const withBankDetails = (c: string, name: string, setters = '{}') => pool.query(
  `INSERT INTO suppliers(company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type,bank_account_holder,bank_details_setters)
   VALUES($1,$2,'FNB','62000000001','250655','cheque','Holder',$3::UUID[]) RETURNING id`, [c, name, setters]);

describe('the bank control in the definer (adversarial review of PR #690)', () => {
  it('an admin may not switch it off — the verifier level is admin, weakening needs above it (RB011); the switch stays (REPRO 2)', async () => {
    const { company: c } = await bankCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin']], companies);
    expect((await bankSwitch(c, u.owner, true)).rowCount).toBe(1);
    expect(await outcome(bankSwitch(c, u.admin, false))).toBe('RB011');
    expect((await pool.query("SELECT 1 FROM approval_enforcement WHERE company_id = $1", [c])).rowCount).toBe(1);
  });

  it('an enabled flag of NULL is refused (RB020), never read as off (REPRO 3)', async () => {
    const { company: c } = await bankCompany(pool, [[u.owner, 'owner']], companies);
    await bankSwitch(c, u.owner, true);
    expect(await outcome(bankSwitch(c, u.owner, null))).toBe('RB020');
    expect((await pool.query("SELECT 1 FROM approval_enforcement WHERE company_id = $1", [c])).rowCount).toBe(1);
  });

  it('after a first switch-on that baselined nobody, switching off and on again baselines nobody either (REPRO 5)', async () => {
    const { company: c } = await bankCompany(pool, [[u.owner, 'owner']], companies);
    expect((await bankSwitch(c, u.owner, true)).rows[0].baseline_suppliers).toBe(0);
    await bankSwitch(c, u.owner, false);
    await withBankDetails(c, 'late');
    expect((await bankSwitch(c, u.owner, true)).rows[0].baseline_suppliers).toBe(0);
  });

  it('the switch preview counts exactly the suppliers the switch-on then baselines (blind L3)', async () => {
    const { company: c } = await bankCompany(pool, [[u.owner, 'owner']], companies);
    await withBankDetails(c, 'a');
    await withBankDetails(c, 'b');
    await withBankDetails(c, 'mine', `{${u.owner}}`);
    const gone = (await withBankDetails(c, 'gone')).rows[0].id as string;
    await pool.query('UPDATE suppliers SET deleted_at = now() WHERE id = $1', [gone]);
    await pool.query("INSERT INTO suppliers(company_id,name) VALUES($1,'no details')", [c]);
    const preview = await callRoute(approvalEnforcement, tokens[u.owner]!, c, 'GET', undefined,
      '/api/accounting/approval-enforcement', { preview: '1' });
    const shown = dataOf<{ preview: Record<string, number> }>(preview).preview.supplier_bank_details;
    expect((await r.toggle(u.owner, c, true)).state.statusCode).toBe(200);
    const { rows: [a] } = await pool.query(`SELECT changes->'metadata'->>'baselineSuppliers' AS n FROM audit_log
      WHERE company_id = $1 AND entity_type = 'approval_enforcement' AND action = 'create'`, [c]);
    expect([shown, Number(a.n)]).toEqual([2, 2]);
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
