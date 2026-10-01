// tests/integration/w2-28-default-accounts-system-flags.int.test.ts
//
// W2-28 (SET-01, SET-02, LED-19). The Default Accounts page read its mappings
// only from app_settings.accounting_default_accounts — empty for most
// companies — so every select showed "Not configured" while the company's
// system accounts were flagged and posting used them. Its POST then cleared
// is_system_account for all 8 managed subtypes before re-marking only the
// accounts in the body, so "Save" on the page as loaded unflagged every system
// account and every auto-posting path for that company threw
// MissingSystemAccountError.
//
// Driven through the real handler — withAuth (app_user + GUCs), CSRF and write
// access — because the property only exists there: GET must show what
// systemAccountResolver will hand out, and a POST may move only the roles it
// changes, refusing (4xx, nothing written) any change that empties a role.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const VIEWER = randomUUID();
const MANAGER = randomUUID();

// UI key → [code, type, subtype, normal balance]. The 9 roles the page manages.
const MANAGED: Record<string, [string, string, string, string]> = {
  sales_revenue:       ['4100', 'revenue',   'default_revenue',   'credit'],
  sales_vat_output:    ['2120', 'liability', 'vat_output',        'credit'],
  accounts_receivable: ['1120', 'asset',     'receivable',        'debit'],
  cost_of_sales:       ['5100', 'expense',   'default_expense',   'debit'],
  purchase_vat_input:  ['1140', 'asset',     'vat_input',         'debit'],
  accounts_payable:    ['2110', 'liability', 'payable',           'credit'],
  primary_bank:        ['1110', 'asset',     'bank',              'debit'],
  retained_earnings:   ['3200', 'equity',    'retained_earnings', 'credit'],
  opening_balance_equity: ['3300', 'equity', 'opening_balance_equity', 'credit'],
};
const ids: Record<string, string> = Object.fromEntries(Object.keys(MANAGED).map((k) => [k, randomUUID()]));
const ALT_AR = randomUUID();       // unflagged asset, a legitimate new AR choice
const ADMIN_EXP = randomUUID();    // system admin_expense — a role the page does not manage
const INACTIVE_AR = randomUUID();  // deactivated asset: the resolver would never hand it out
const SPARE_EXP = randomUUID();    // unflagged expense: the wrong type for any asset role
const B_AR = randomUUID();         // company B's AR system account
const CONTEST_AR = randomUUID();   // second flagged receivable, newer: preferSystemAccount picks it

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
type Flag = { id: string; account_subtype: string | null; is_system_account: boolean };

describeIfDb('W2-28 — Default Accounts reflects and preserves system account flags', () => {
  let pool: Pool;
  let token = '';
  const tokens: Record<string, string> = {};

  async function call(handler: Handler, method: string, body?: unknown, as = token) {
    const req = request({ 'sb-access-token': as, active_company_id: A }, method) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state as { statusCode: number; body: { data?: { mappings?: Record<string, string> } } };
  }

  /** A POST body as the page sends it: the changed keys plus the holders it loaded for them. */
  const withLoaded = async (mappings: Record<string, string>) => {
    const shown = (await call(defaultAccounts, 'GET')).body.data?.mappings ?? {};
    return { mappings, loaded: Object.fromEntries(Object.keys(mappings).map((k) => [k, shown[k] ?? ''])) };
  };

    /** Accounts of company A flagged for `subtype`. */
  const holdersOf = async (subtype: string): Promise<string[]> =>
    (await pool.query(
      `SELECT id::TEXT AS id FROM gl_accounts
       WHERE company_id = $1 AND account_subtype = $2 AND is_system_account = true AND is_active = true`,
      [A, subtype])).rows.map((r) => String(r.id)).sort();

  /** Every account of company A that holds a system role, by id. */
  const flagsOfA = async (): Promise<Map<string, Flag>> => {
    const rows = (await pool.query(
      `SELECT id::TEXT AS id, account_subtype, is_system_account FROM gl_accounts
       WHERE company_id = $1 AND is_system_account = true`, [A])).rows as Flag[];
    return new Map(rows.map((r) => [r.id, r]));
  };
  const settingsOfA = async () =>
    (await pool.query(`SELECT value FROM app_settings WHERE company_id = $1 AND key = 'accounting_default_accounts'`,
      [A])).rows.map((r) => String(r.value));

  async function seedChart() {
    await pool.query('DELETE FROM app_settings WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [[A, B]]);
    const insert = (id: string, co: string, code: string, type: string, subtype: string | null, normal: string,
      system: boolean, active = true) => pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, co, code, `W228 ${code}`, type, subtype, normal, active, system]);
    for (const [key, [code, type, subtype, normal]] of Object.entries(MANAGED)) {
      await insert(ids[key]!, A, code, type, subtype, normal, true);
    }
    await insert(ALT_AR, A, '1125', 'asset', null, 'debit', false);
    await insert(ADMIN_EXP, A, '6100', 'expense', 'admin_expense', 'debit', true);
    await insert(INACTIVE_AR, A, '1126', 'asset', null, 'debit', false, false);
    await insert(SPARE_EXP, A, '6200', 'expense', null, 'debit', false);
    await insert(B_AR, B, '1120', 'asset', 'receivable', 'debit', true);
  }

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'W228 Co A', B, 'W228 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `w228-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    for (const [id, role] of [[VIEWER, 'viewer'], [MANAGER, 'manager']] as const) {
      await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)',
        [id, `w228-${role}-${id}@isaflow.test`, role]);
      await pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [A, id, role]);
    }
    const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    token = await sign(USER);
    tokens.viewer = await sign(VIEWER);
    tokens.manager = await sign(MANAGER);
  });

  beforeEach(seedChart);

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[USER, VIEWER, MANAGER]]);
    } finally {
      await pool.end();
    }
  });

  it('GET shows the flagged system account for each role when app_settings has no row', async () => {
    const state = await call(defaultAccounts, 'GET');
    expect(state.statusCode).toBe(200);
    expect(state.body.data?.mappings?.accounts_receivable ?? 'Not configured').toBe(ids.accounts_receivable);
    for (const key of Object.keys(MANAGED)) expect(state.body.data?.mappings?.[key]).toBe(ids[key]);
  });

  it('GET prefers the live flag over a stale app_settings mapping', async () => {
    await pool.query(
      `INSERT INTO app_settings (key, value, company_id, updated_at)
       VALUES ('accounting_default_accounts', $1, $2, NOW())`,
      [JSON.stringify({ accounts_receivable: ALT_AR, retained_earnings: ALT_AR, petty_cash: ids.primary_bank }), A]);
    await pool.query('UPDATE gl_accounts SET is_system_account = false WHERE id = $1', [ids.retained_earnings]);
    const state = await call(defaultAccounts, 'GET');
    expect(state.body.data?.mappings?.accounts_receivable).toBe(ids.accounts_receivable);
    // A role nothing holds shows "Not configured", whatever app_settings says.
    expect(state.body.data?.mappings?.retained_earnings).toBeUndefined();
    // An unmanaged row still round-trips from app_settings.
    expect(state.body.data?.mappings?.petty_cash).toBe(ids.primary_bank);
  });

  it('POST {mappings:{}} keeps all 9 managed system flags', async () => {
    const state = await call(defaultAccounts, 'POST', { mappings: {} });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const flags = await flagsOfA();
    expect(Object.values(ids).filter((id) => flags.has(id))).toHaveLength(9);
  });

  it('Save on the page as loaded (GET then POST the same mappings) keeps every flag', async () => {
    const before = await flagsOfA();
    const loaded = await call(defaultAccounts, 'GET');
    const state = await call(defaultAccounts, 'POST', { mappings: loaded.body.data?.mappings ?? {} });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await flagsOfA()).toEqual(before);
  });

  it('Save as loaded succeeds when a held role\'s account is mistyped (unchanged roles are not re-validated)', async () => {
    await pool.query("UPDATE gl_accounts SET account_type = 'liability' WHERE id = $1", [ids.purchase_vat_input]);
    const before = await flagsOfA();
    const loaded = await call(defaultAccounts, 'GET');
    expect(loaded.body.data?.mappings?.purchase_vat_input).toBe(ids.purchase_vat_input);
    const state = await call(defaultAccounts, 'POST', { mappings: loaded.body.data?.mappings ?? {} });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await flagsOfA()).toEqual(before);
  });

  it('POST changing one role moves only that flag', async () => {
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: ALT_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const flags = await flagsOfA();
    expect(flags.get(ALT_AR)).toMatchObject({ account_subtype: 'receivable', is_system_account: true });
    expect(flags.has(ids.accounts_receivable!)).toBe(false);
    for (const key of Object.keys(MANAGED).filter((k) => k !== 'accounts_receivable')) {
      expect(flags.get(ids[key]!), key).toMatchObject({ account_subtype: MANAGED[key]![2] });
    }
    expect(flags.has(ADMIN_EXP)).toBe(true);
    const again = await call(defaultAccounts, 'GET');
    expect(again.body.data?.mappings?.accounts_receivable).toBe(ALT_AR);
  });

  it('POST that clears a held role is refused 400 and writes nothing', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: '', petty_cash: ALT_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/receivable/i);
    expect(await flagsOfA()).toEqual(before);
    expect(await settingsOfA()).toHaveLength(0);
  });

  it('POST that takes an account from another role (admin_expense) is refused 400 and writes nothing', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST', await withLoaded({ cost_of_sales: ADMIN_EXP }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/admin_expense/);
    expect(await flagsOfA()).toEqual(before);
    expect(await settingsOfA()).toHaveLength(0);
  });

  it('POST naming a deactivated account is refused 400 and writes nothing', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: INACTIVE_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/1126.*inactive/);
    expect(await flagsOfA()).toEqual(before);
  });

  it('POST naming an account of the wrong type is refused 400 and writes nothing', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: SPARE_EXP }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/must be of type 'asset'/);
    expect(await flagsOfA()).toEqual(before);
  });

  it('a viewer\'s POST is refused 403 and writes nothing; a manager\'s POST is allowed', async () => {
    const before = await flagsOfA();
    const viewer = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: ALT_AR }), tokens.viewer);
    expect(viewer.statusCode, JSON.stringify(viewer.body)).toBe(403);
    expect(await flagsOfA()).toEqual(before);
    const manager = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: ALT_AR }), tokens.manager);
    expect(manager.statusCode, JSON.stringify(manager.body)).toBe(200);
    expect(await holdersOf('receivable')).toEqual([ALT_AR]);
  });

  it('contested role: GET shows the resolver\'s winner, and re-pointing leaves exactly one holder', async () => {
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account, created_at)
       VALUES ($1, $2, '1121', 'W228 1121', 'asset', 'receivable', 'debit', true, true, NOW() + INTERVAL '1 hour')`,
      [CONTEST_AR, A]);
    const loaded = await call(defaultAccounts, 'GET');
    // Newer type-fitting row wins (preferSystemAccount), not the lowest code.
    expect(loaded.body.data?.mappings?.accounts_receivable).toBe(CONTEST_AR);
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: ALT_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await holdersOf('receivable')).toEqual([ALT_AR]);
  });

  it('swapping two roles in one save (receivable <-> bank) is refused: an account may not be reclassified by assignment', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST',
      await withLoaded({ accounts_receivable: ids.primary_bank!, primary_bank: ids.accounts_receivable! }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/1110 is classified 'bank'.*It must be reclassified to 'other' first/);
    expect(await flagsOfA()).toEqual(before);
  });

  it('one account named for two roles is refused 400 and writes nothing', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST',
      await withLoaded({ accounts_receivable: ALT_AR, primary_bank: ALT_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(JSON.stringify(state.body)).toMatch(/cannot hold two roles/);
    expect(await flagsOfA()).toEqual(before);
    expect(await settingsOfA()).toHaveLength(0);
  });

  it('an array for mappings is refused (422, the same validation error as any non-object) and writes nothing', async () => {
    const state = await call(defaultAccounts, 'POST', { mappings: [ALT_AR] });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(422);
    expect(await settingsOfA()).toHaveLength(0);
  });

  it('POST naming company B\'s account is refused 400 and writes nothing (tenant control)', async () => {
    const before = await flagsOfA();
    const state = await call(defaultAccounts, 'POST', await withLoaded({ accounts_receivable: B_AR }));
    expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
    expect(await flagsOfA()).toEqual(before);
  });
});
