// tests/integration/w2-28-default-accounts-save-contract.int.test.ts
//
// W2-28 round 3. The page now sends only the keys the user changed plus the
// holder it loaded for each; the server refuses 409 when that holder has moved
// since (two tabs used to silently revert each other's save). Also pinned here:
// the positive arm of Hein's classification ruling (an 'other' account, or an
// unflagged account already classified for the role, may take it), a header at
// ANY level is refused, and unmanaged rows saved one at a time are merged into
// app_settings rather than replacing it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID(); const USER = randomUUID();
const BANK = randomUUID(); const BANK2 = randomUUID(); const AR = randomUUID(); const AR2 = randomUUID();
const OTHER = randomUUID(); const L3_PARENT = randomUUID(); const L3_CHILD = randomUUID();

type State = { statusCode: number; body: { data?: { mappings?: Record<string, string> }; error?: { message?: string } } };

describeIfDb('W2-28 — Default Accounts save contract', () => {
  let pool: Pool; let token = '';
  async function call(method: string, body?: Record<string, unknown>): Promise<State> {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return out.state as State;
  }
  const holder = async (subtype: string) => (await pool.query(
    'SELECT id::TEXT AS id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 AND is_system_account',
    [A, subtype])).rows.map((r) => String(r.id));

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'W228 contract Co']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `w228k-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM app_settings WHERE company_id = $1', [A]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1 AND parent_account_id IS NOT NULL', [A]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [A]);
    const ins = (id: string, code: string, sub: string | null, sys: boolean, parent: string | null = null) => pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active, is_system_account, level, parent_account_id)
       VALUES ($1, $2, $3, $3, 'asset', $4, 'debit', true, $5, 3, $6)`, [id, A, code, sub, sys, parent]);
    await ins(BANK, '1110', 'bank', true);
    await ins(BANK2, '1111', 'bank', false);
    await ins(AR, '1120', 'receivable', true);
    await ins(AR2, '1121', null, false);
    await ins(OTHER, '1190', 'other', false);
    await ins(L3_PARENT, '1150', null, false);
    await ins(L3_CHILD, '1151', null, false, L3_PARENT);
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM app_settings WHERE company_id = $1', [A]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1 AND parent_account_id IS NOT NULL', [A]);
      for (const t of ['gl_accounts', 'company_users']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally { await pool.end(); }
  });

  it('two tabs: the page\'s changed-keys save keeps the other tab\'s move; a stale move is refused 409', async () => {
    const tabA = (await call('GET')).body.data!.mappings!;
    const tabB = await call('POST', { mappings: { primary_bank: BANK2 }, loaded: { primary_bank: tabA.primary_bank } });
    expect(tabB.statusCode, JSON.stringify(tabB.body)).toBe(200);
    // Tab A changes only receivable — exactly what the page now sends.
    const save = await call('POST', { mappings: { accounts_receivable: AR2 }, loaded: { accounts_receivable: tabA.accounts_receivable } });
    expect(save.statusCode, JSON.stringify(save.body)).toBe(200);
    expect({ bank: await holder('bank'), ar: await holder('receivable') }).toEqual({ bank: [BANK2], ar: [AR2] });
    // Tab A now moves bank from what it saw (1110), which is no longer the holder.
    const stale = await call('POST', { mappings: { primary_bank: BANK }, loaded: { primary_bank: tabA.primary_bank } });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error?.message).toMatch(/changed since you loaded this page/);
    expect(await holder('bank')).toEqual([BANK2]);
  });

  it('an account classified \'other\' may take a role', async () => {
    const res = await call('POST', { mappings: { primary_bank: OTHER }, loaded: { primary_bank: BANK } });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await holder('bank')).toEqual([OTHER]);
  });

  it('a level-3 account with sub-accounts is refused as a holder, naming it', async () => {
    const res = await call('POST', { mappings: { accounts_receivable: L3_PARENT }, loaded: { accounts_receivable: AR } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toMatch(/1150 is a header with sub-accounts/);
    expect(await holder('receivable')).toEqual([AR]);
  });

  it('unmanaged rows saved one at a time are merged into app_settings, not replaced', async () => {
    expect((await call('POST', { mappings: { petty_cash: AR2 } })).statusCode).toBe(200);
    expect((await call('POST', { mappings: { rounding: OTHER } })).statusCode).toBe(200);
    const shown = (await call('GET')).body.data!.mappings!;
    expect({ petty: shown.petty_cash, rounding: shown.rounding }).toEqual({ petty: AR2, rounding: OTHER });
  });
});
