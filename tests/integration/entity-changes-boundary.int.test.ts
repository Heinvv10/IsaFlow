/**
 * Migration 888 — what entity_changes refuses, and who may read it:
 *  - append-only for every role: app_user and platform_admin hold no write at
 *    all, the owner's UPDATE / DELETE / TRUNCATE / direct INSERT are refused
 *    by trigger; the one delete that passes is the cascade of a purged
 *    company, and purging a company with history works;
 *  - nobody but the owner can attach the capture function to a table of
 *    their own (a forged history row by a temp table's trigger);
 *  - reading is tenant- and role-bound in RLS: suppliers / customers / GL
 *    accounts for any member, payroll employees for owner / admin / manager,
 *    the rest for owner / admin; never another company's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, asApp, changesOf, cleanupEntityChanges, members, newCompany, outcome } from './entity-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '', x = '';

beforeAll(async () => { [o, a, m, v, x] = await members(pool, tokens, 5); });
afterAll(() => cleanupEntityChanges(pool, companies, [o, a, m, v, x]));

async function companyWithHistory() {
  const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);
  const one = async (q: string, p: unknown[]) => (await pool.query(q, p)).rows[0].id as string;
  const ids = {
    supplier: await one("INSERT INTO suppliers(company_id, name) VALUES($1,'B sup') RETURNING id", [c]),
    customer: await one("INSERT INTO customers(company_id, name) VALUES($1,'B cust') RETURNING id", [c]),
    gl_account: await one(`INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance)
      VALUES($1,'B1','B acc','expense','debit') RETURNING id`, [c]),
    payroll_employee: await one(`INSERT INTO payroll_employees(company_id, employee_number, first_name, last_name, employment_type, start_date)
      VALUES($1,'B1','B','Emp','permanent','2026-01-01') RETURNING id`, [c]),
    approval_rule: await one(`INSERT INTO approval_rules(company_id, name, document_type, condition_field, condition_operator,
      condition_value, approver_role, is_active) VALUES($1,'B rule','supplier_invoice','amount','any',0,'admin',true) RETURNING id`, [c]),
  };
  return { c, ids };
}

const visible = (user: string, c: string) => asApp(pool, user, c, async (db) =>
  (await db.query('SELECT entity_type FROM entity_changes')).rows.map((r) => r.entity_type as string));

describe('append-only', () => {
  it('app_user and platform_admin can write nothing; the owner can only read', async () => {
    const { c, ids } = await companyWithHistory();
    const rowId = (await pool.query('SELECT id FROM entity_changes WHERE entity_id = $1', [ids.supplier])).rows[0]?.id as string;
    const writes = [
      `INSERT INTO entity_changes(company_id, entity_type, entity_id, op, changed, after, actor, channel, db_role, login_role, txid, recorded_at)
        VALUES('${c}','supplier','${ids.supplier}','create','{}','{}','${a}','session','app_user','postgres',1,now())`,
      `UPDATE entity_changes SET actor = 'someone' WHERE id = '${rowId}'`,
      `DELETE FROM entity_changes WHERE company_id = '${c}'`,
      'TRUNCATE entity_changes',
    ];
    for (const q of writes) {
      expect(await outcome(asApp(pool, o, c, (db) => db.query(q))), q).toMatch(/^42501/);
      expect(await outcome(as(pool, o, { role: 'platform_admin', claims: { sub: o } }, (db) => db.query(q))), q).toMatch(/^42501/);
    }
    expect(await outcome(as(pool, o, { role: 'platform_admin', claims: { sub: o } }, (db) => db.query('SELECT 1 FROM entity_changes'))))
      .toMatch(/^42501/);
    // seq and txid count every tenant's writes: a member cannot read them (breaker #696 R3 / r2 #2).
    for (const col of ['seq', 'txid', '*']) {
      expect(await outcome(asApp(pool, o, c, (db) => db.query(`SELECT ${col} FROM entity_changes`))), col).toMatch(/^42501/);
    }
    expect(await outcome(asApp(pool, o, c, (db) => db.query('SELECT id, recorded_at, actor FROM entity_changes')))).toBe('ok');
    // The owner (the fixture's login role) is refused by the triggers.
    expect(await outcome(pool.query(writes[0]!))).toMatch(/^42501: .*recorded by the changed table itself/);
    expect(await outcome(pool.query(writes[1]!))).toMatch(/^42501: .*append-only \(UPDATE/);
    expect(await outcome(pool.query(writes[2]!))).toMatch(/^42501: .*append-only \(DELETE/);
    expect(await outcome(pool.query('TRUNCATE entity_changes CASCADE'))).toMatch(/^42501: .*append-only \(TRUNCATE/);
    expect(await changesOf(pool, ids.supplier)).toHaveLength(1);
  });

  it('a purged company takes its history with it; other companies keep theirs', async () => {
    const doomed = await companyWithHistory();
    const kept = await companyWithHistory();
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', [doomed.c]);
    expect((await changesOf(pool, doomed.ids.supplier)).map((r) => r.op)).toEqual(['create', 'delete']);
    await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [doomed.c]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [doomed.c]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [doomed.c]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [doomed.c]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [doomed.c]);
    expect(await outcome(pool.query('DELETE FROM companies WHERE id = $1', [doomed.c]))).toBe('ok');
    expect((await pool.query('SELECT count(*)::int AS n FROM entity_changes WHERE company_id = $1', [doomed.c])).rows[0].n).toBe(0);
    expect(await changesOf(pool, kept.ids.supplier)).toHaveLength(1);
  });

  it('nobody but the owner can attach the capture to a table of their own', async () => {
    const { c } = await companyWithHistory();
    expect(await outcome(asApp(pool, a, c, async (db) => {
      await db.query('CREATE TEMP TABLE forge(id uuid, company_id uuid) ON COMMIT DROP');
      await db.query("CREATE TRIGGER forge AFTER INSERT ON forge FOR EACH ROW EXECUTE FUNCTION public.entity_change_capture('supplier')");
    }))).toMatch(/^42501: permission denied for function (public\.)?entity_change_capture/);
    for (const fn of ["public.entity_change_projection('supplier', '{}')", "public.entity_change_keys('{}', '{}')",
      "public.entity_change_secret_digest('x')"]) {
      expect(await outcome(asApp(pool, a, c, (db) => db.query(`SELECT ${fn}`))), fn).toMatch(/^42501/);
    }
  });
});

describe('reading', () => {
  it('follows the entity: any member reads suppliers, customers and GL accounts; payroll from manager up; the rest owner / admin', async () => {
    const { c } = await companyWithHistory();
    const kinds = (rows: string[]) => [...new Set(rows)].sort();
    expect(kinds(await visible(v, c))).toEqual(['customer', 'gl_account', 'supplier']);
    expect(kinds(await visible(m, c))).toEqual(['customer', 'gl_account', 'payroll_employee', 'supplier']);
    for (const admin of [o, a]) {
      expect(kinds(await visible(admin, c))).toEqual(
        ['approval_rule', 'company', 'company_user', 'customer', 'gl_account', 'payroll_employee', 'supplier']);
    }
  });

  it("never another company's: not as a non-member, not with the company GUC pointed elsewhere", async () => {
    const one = await companyWithHistory();
    const other = await newCompany(pool, [[x, 'owner'], [o, 'owner']], companies);
    expect(await visible(x, one.c)).toEqual([]);
    // o belongs to both; with the GUC on the other company, one's history is not shown.
    const seen = await asApp(pool, o, other, async (db) =>
      (await db.query('SELECT DISTINCT company_id FROM entity_changes')).rows.map((r) => r.company_id as string));
    expect(seen).toEqual([other]);
  });
});
