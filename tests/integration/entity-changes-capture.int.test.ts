/**
 * Migration 888 — what the database records of a master-data write, whoever
 * writes it: one entity_changes row per write that changes the row's
 * projection, with before / after, the changed keys, the actor and the
 * channel. Raw SQL as each channel runs it; the routes and MCP are covered by
 * entity-changes-routes.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { as, asApp, changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '';

beforeAll(async () => { [o, a] = await members(pool, tokens, 2); });
afterAll(() => cleanupEntityChanges(pool, companies, [o, a]));

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin']], companies);
/** As the invitation writes run since S-07c (930): migration_admin, under the inviter's session claims. */
const asInviter = <T>(c: string, fn: (db: PoolClient) => Promise<T>) => as(pool, o, { role: 'migration_admin', company: c }, fn);
const newSupplier = async (c: string) => (await asApp(pool, a, c, (db) => db.query(
  "INSERT INTO suppliers(company_id, name, bank_account_number) VALUES($1, 'EC supplier', '1111222233') RETURNING id", [c]))).rows[0].id as string;

describe('a supplier through its life, as a person in their own session', () => {
  it('records create, update and delete with before / after, the changed keys and who', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await asApp(pool, a, c, (db) => db.query("UPDATE suppliers SET bank_account_number = '9999888877', payment_terms = 45 WHERE id = $1", [s]));
    await asApp(pool, a, c, (db) => db.query('DELETE FROM suppliers WHERE id = $1', [s]));
    const rows = await changesOf(pool, s);
    expect(rows.map((r) => r.op)).toEqual(['create', 'update', 'delete']);
    const [created, updated, deleted] = rows;
    expect(created!.before).toBeNull();
    expect(created!.after).toMatchObject({ name: 'EC supplier', bank_account_number: '1111222233', company_id: c });
    expect(created!.after).not.toHaveProperty('id');
    expect(created!.after).not.toHaveProperty('updated_at');
    expect(created!.changed).toContain('bank_account_number');
    expect(updated!.changed).toEqual(['bank_account_number', 'payment_terms']);
    expect(updated!.before).toMatchObject({ bank_account_number: '1111222233' });
    expect(updated!.after).toMatchObject({ bank_account_number: '9999888877', payment_terms: 45 });
    expect(deleted!.after).toBeNull();
    expect(deleted!.before).toMatchObject({ bank_account_number: '9999888877' });
    for (const r of rows) {
      expect(r).toMatchObject({ company_id: c, entity_type: 'supplier', actor: a, channel: 'session', db_role: 'app_user',
        impersonator: null });
      expect(r.session_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.login_role).toBe((await pool.query('SELECT session_user AS u')).rows[0].u);
    }
    expect(Number(created!.seq)).toBeLessThan(Number(updated!.seq));
  });

  it('records nothing for a write that changes nothing it records', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await asApp(pool, a, c, (db) => db.query('UPDATE suppliers SET name = name, updated_at = now() + interval \'1 day\' WHERE id = $1', [s]));
    await asApp(pool, a, c, (db) => db.query('UPDATE suppliers SET bank_details_setters = ARRAY[$2::uuid] WHERE id = $1', [s, a]));
    expect((await changesOf(pool, s)).map((r) => r.op)).toEqual(['create']);
  });

  it('a row moved to another company is recorded in both', async () => {
    const c1 = await company();
    const c2 = await company();
    const s = await newSupplier(c1);
    await pool.query('UPDATE suppliers SET company_id = $2 WHERE id = $1', [s, c2]);
    const moved = (await changesOf(pool, s)).filter((r) => r.op === 'update');
    expect(moved.map((r) => r.company_id).sort()).toEqual([c1, c2].sort());
    expect(moved[0]!.changed).toEqual(['company_id']);
  });
});

describe('the channel and the actor', () => {
  it('an MCP token (claims, no session id) is `token`', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await as(pool, a, { company: c, claims: { sub: a, role: 'authenticated', company_id: c } },
      (db) => db.query("UPDATE suppliers SET email = 'mcp@x.test' WHERE id = $1", [s]));
    expect((await changesOf(pool, s)).at(-1)).toMatchObject({ channel: 'token', actor: a, session_id: null });
  });

  it('Login-as is `impersonation`, naming the platform admin behind it', async () => {
    const c = await company();
    const s = await newSupplier(c);
    const sid = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)', [sid, o, a]);
    try {
      await as(pool, a, { company: c, claims: { sub: a, session_id: sid } },
        (db) => db.query("UPDATE suppliers SET email = 'imp@x.test' WHERE id = $1", [s]));
    } finally { await pool.query('DELETE FROM impersonation_sessions WHERE session_id = $1', [sid]); }
    expect((await changesOf(pool, s)).at(-1)).toMatchObject({ channel: 'impersonation', actor: a, impersonator: o, session_id: sid });
  });

  it('the platform-admin connection is `platform_admin`, with the admin as actor', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await as(pool, o, { role: 'platform_admin', claims: { sub: o } },
      (db) => db.query("UPDATE suppliers SET email = 'pa@x.test' WHERE id = $1", [s]));
    expect((await changesOf(pool, s)).at(-1)).toMatchObject({ channel: 'platform_admin', actor: o, db_role: 'platform_admin' });
  });

  it('a script (no claims, no role) is `system`, as db:<login role>', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await pool.query("UPDATE suppliers SET email = 'script@x.test' WHERE id = $1", [s]);
    const login = (await pool.query('SELECT session_user AS u')).rows[0].u as string;
    expect((await changesOf(pool, s)).at(-1)).toMatchObject({ channel: 'system', actor: `db:${login}`, db_role: login });
  });

  it('a superuser bulk write in replica mode is still recorded (ENABLE ALWAYS)', async () => {
    const c = await company();
    const s = await newSupplier(c);
    await as(pool, a, { role: null, claims: null }, async (db) => {
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query("UPDATE suppliers SET bank_account_number = '7777000011' WHERE id = $1", [s]);
    });
    expect((await changesOf(pool, s)).at(-1)).toMatchObject({ op: 'update', changed: ['bank_account_number'], channel: 'system' });
  });
});

describe('every tracked table records', () => {
  it('customers, GL accounts, payroll employees, members, invitations, permissions, rules, switches', async () => {
    const c = await company();
    const ids = await asApp(pool, o, c, async (db) => {
      const one = async (q: string, p: unknown[]) => (await db.query(q, p)).rows[0].id as string;
      return {
        customer: await one("INSERT INTO customers(company_id, name, credit_limit) VALUES($1,'EC cust',100) RETURNING id", [c]),
        gl_account: await one(`INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, account_subtype,
          bank_account_number) VALUES($1,'EC1','EC Bank','asset','debit','bank','5555666677') RETURNING id`, [c]),
        payroll_employee: await one(`INSERT INTO payroll_employees(company_id, employee_number, first_name, last_name, id_number,
          employment_type, start_date, medical_aid_main_member) VALUES($1,'E1','Ec','Emp','8001015009087','permanent','2026-01-01', true) RETURNING id`, [c]),
        company_user_permission: await one(`INSERT INTO company_user_permissions(company_id, user_id, module_key, can_read)
          VALUES($1,$2,'payroll',true) RETURNING id`, [c, a]),
      };
    });
    // Invitations are written on the migration_admin pool, under the request's claims (S-07c, 930).
    const company_invitation = await asInviter(c, async (db) => (await db.query(`INSERT INTO company_invitations(company_id, email,
      role, invited_by, token, expires_at) VALUES($1,'inv@x.test','manager',$2,'tok-hash',now() + interval '1 day') RETURNING id`,
    [c, o])).rows[0].id as string);
    const rule = (await pool.query(`INSERT INTO approval_rules(company_id, name, document_type, condition_field, condition_operator,
      condition_value, approver_role, is_active) VALUES($1,'EC rule','supplier_invoice','amount','greater_than',1000,'admin',true) RETURNING id`, [c])).rows[0].id;
    const sw = (await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_invoice',$2) RETURNING id",
      [c, o])).rows[0].id;
    const member = (await pool.query('SELECT id FROM company_users WHERE company_id = $1 AND user_id = $2', [c, a])).rows[0].id;
    await asApp(pool, o, c, (db) => db.query("UPDATE company_users SET role = 'manager' WHERE id = $1", [member]));
    const expected: Record<string, string> = { ...ids, company_invitation, approval_rule: rule, approval_enforcement: sw };
    for (const [type, id] of Object.entries(expected)) {
      const rows = await changesOf(pool, id);
      expect(rows.length, type).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ entity_type: type, company_id: c, op: 'create' });
    }
    const roleChange = (await changesOf(pool, member)).at(-1)!;
    expect(roleChange).toMatchObject({ entity_type: 'company_user', op: 'update', changed: ['role'], actor: o });
    expect(roleChange.before).toMatchObject({ role: 'admin', user_id: a });
    const invitation = (await changesOf(pool, company_invitation))[0]!;
    expect(invitation).toMatchObject({ actor: o, channel: 'session' });
    expect(invitation.after!.token).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(invitation)).not.toContain('tok-hash');
  });

  it('companies: tax, VAT, bank, pay-to and mail settings are recorded; display settings are not; Netcash keys only as a digest', async () => {
    const c = await company();
    await asApp(pool, o, c, (db) => db.query("UPDATE companies SET vat_number = '4111111111', bank_account_number = '123456789' WHERE id = $1", [c]));
    await asApp(pool, o, c, (db) => db.query("UPDATE companies SET currency_symbol = 'X', portal_primary_color = '#000' WHERE id = $1", [c]));
    await asApp(pool, o, c, (db) => db.query("UPDATE companies SET netcash_payouts_key = 'super-secret-key-1' WHERE id = $1", [c]));
    // Breaker #696 R1: where customers are told to pay, and the mail that carries it.
    await asApp(pool, o, c, (db) => db.query(`UPDATE companies SET portal_payment_instructions = 'Pay FNB 62999999999',
      email = 'a@x.test', billing_email = 'b@x.test', invoice_email_body = 'new banking details', chase_auto_send_enabled = true,
      phone = '+27 82 000 6666', address_line1 = '1 Elsewhere Rd', portal_allow_payments = false WHERE id = $1`, [c]));
    const rows = (await changesOf(pool, c)).filter((r) => r.op === 'update');
    expect(rows.map((r) => r.changed)).toEqual([['bank_account_number', 'vat_number'], ['netcash_payouts_key'],
      ['address_line1', 'billing_email', 'chase_auto_send_enabled', 'email', 'invoice_email_body', 'phone', 'portal_allow_payments',
        'portal_payment_instructions']]);
    const keyChange = rows[1]!;
    expect(JSON.stringify(keyChange)).not.toContain('super-secret-key-1');
    expect(keyChange.after!.netcash_payouts_key).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(keyChange.before!.netcash_payouts_key).toBeNull();
    expect(keyChange.entity_type).toBe('company');
  });

  it('an invitation re-pointed to another account or re-issued is recorded; the token only as a digest (breaker #696 R6)', async () => {
    const c = await company();
    const inv = await asInviter(c, async (db) => (await db.query(`INSERT INTO company_invitations(company_id, email, role,
      invited_by, token, expires_at) VALUES($1,'r6@x.test','manager',$2,'tok-one',now() + interval '1 day') RETURNING id`, [c, o])).rows[0].id);
    const account = crypto.randomUUID();
    await asInviter(c, (db) => db.query("UPDATE company_invitations SET gotrue_user_id = $2, token = 'tok-two' WHERE id = $1", [inv, account]));
    await asInviter(c, (db) => db.query("UPDATE company_invitations SET email_sent_at = now() WHERE id = $1", [inv]));
    const rows = await changesOf(pool, inv);
    expect(rows.map((r) => [r.op, r.changed])).toEqual([
      ['create', ['company_id', 'email', 'expires_at', 'invited_by', 'role', 'token']], ['update', ['gotrue_user_id', 'token']]]);
    expect(rows[1]!.after).toMatchObject({ gotrue_user_id: account });
    expect(rows[1]!.after!.token).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(rows)).not.toMatch(/tok-one|tok-two/);
  });

  it('a re-keyed row is recorded under both ids (breaker #696 R2)', async () => {
    const c = await company();
    const s = await newSupplier(c);
    const moved = crypto.randomUUID();
    await asApp(pool, a, c, (db) => db.query('UPDATE suppliers SET id = $2 WHERE id = $1', [s, moved]));
    const [old] = (await changesOf(pool, s)).filter((r) => r.op === 'update');
    const [now] = await changesOf(pool, moved);
    for (const r of [old, now]) {
      expect(r).toMatchObject({ op: 'update', changed: ['id'], before: { id: s }, after: { id: moved }, actor: a });
    }
    expect(old!.entity_id).toBe(s);
    expect(now!.entity_id).toBe(moved);
  });
});
