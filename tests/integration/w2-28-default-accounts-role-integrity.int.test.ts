// Adversarial repros for PR #593 (default-accounts POST/GET). Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const USER = randomUUID();
const BANK = randomUUID();
const AR = randomUUID();
const VAT_IN_W = randomUUID();   // 1140 VAT Input, asset, newer  -> resolver winner
const VAT_IN_L = randomUUID();   // 0900 VAT Payable, LIABILITY, older, also flagged vat_input
const OBE = randomUUID();        // flagged opening_balance_equity
const OBE_OTHER = randomUUID();  // another equity account
const SPARE_ASSET = randomUUID();

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
type State = { statusCode: number; body: { data?: { mappings?: unknown }; message?: string } };

describeIfDb('PR #593 breaker', () => {
  let pool: Pool;
  let token = '';

  async function call(method: string, body?: Record<string, unknown>): Promise<State> {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as Handler)(req as never, out.res as never);
    return out.state as State;
  }
  const insert = (id: string, code: string, type: string, subtype: string | null, normal: string,
    system: boolean, createdAt = 'now()') => pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, ${createdAt})`,
    [id, A, code, `BRK ${code}`, type, subtype, normal, system]);

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'BRK593 Co A']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `brk593-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM app_settings WHERE company_id = $1', [A]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [A]);
    await insert(BANK, '1110', 'asset', 'bank', 'debit', true);
    await insert(AR, '1120', 'asset', 'receivable', 'debit', true);
    await insert(VAT_IN_L, '0900', 'liability', 'vat_input', 'credit', true, "'2020-01-01'");
    await insert(VAT_IN_W, '1140', 'asset', 'vat_input', 'debit', true);
    await insert(OBE, '3300', 'equity', 'opening_balance_equity', 'credit', true);
    await insert(OBE_OTHER, '3310', 'equity', null, 'credit', false);
    await insert(SPARE_ASSET, '1125', 'asset', null, 'debit', false);
    clearSystemAccountCache(A);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      }
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  it('REPRO 1: a save must not silently change the holder of a role it did not touch', async () => {
    clearSystemAccountCache(A);
    expect((await getSystemAccount('vat_input', A)).id).toBe(VAT_IN_W);
    // Re-point bank to the account the resolver uses for vat_input.
    const state = await call('POST', { mappings: { primary_bank: VAT_IN_W } });
    clearSystemAccountCache(A);
    const vatInputNow = (await getSystemAccount('vat_input', A)).id;
    if (state.statusCode === 200) expect(vatInputNow, 'new vat_input holder is the liability').toBe(VAT_IN_L);
    // Either refuse, or leave vat_input on the account it was on. Neither happens.
    expect({ status: state.statusCode, vatInputNow },
      'vat_input moved to 0900 VAT Payable (a liability) while the save returned 200')
      .toEqual({ status: 400, vatInputNow: VAT_IN_W });
  });

  it('REPRO 2: one account for two roles — 200 while a role named in the save ends up empty', async () => {
    await pool.query('UPDATE gl_accounts SET is_system_account = false WHERE id = $1', [BANK]); // bank not held
    const state = await call('POST', { mappings: { primary_bank: SPARE_ASSET, accounts_receivable: SPARE_ASSET } });
    const get = await call('GET');
    const m = get.body.data?.mappings as Record<string, string>;
    expect({ status: state.statusCode, bank: m.primary_bank ?? 'Not configured' },
      'POST said saved:true but primary_bank is not what was saved')
      .toEqual({ status: 400, bank: 'Not configured' });
  });

  it('REPRO 3: Opening Balance Equity row saves 200 and GET shows it, but the resolver uses another account', async () => {
    const state = await call('POST', { mappings: { opening_balance_equity: OBE_OTHER }, loaded: { opening_balance_equity: OBE } });
    expect(state.statusCode).toBe(200);
    const get = await call('GET');
    const shown = (get.body.data?.mappings as Record<string, string>).opening_balance_equity;
    clearSystemAccountCache(A);
    const used = (await getSystemAccount('opening_balance_equity', A)).id;
    expect(shown, 'page shows the saved OBE account; posting uses the flagged one').toBe(used);
  });

  it('REPRO 4: POST {mappings: []} returns 200 and GET then hides every held role', async () => {
    const before = await call('GET');
    expect(Object.keys(before.body.data?.mappings as object)).toContain('primary_bank');
    const state = await call('POST', { mappings: [] });
    const after = await call('GET');
    expect({ status: state.statusCode >= 400 && state.statusCode < 500 ? '4xx' : state.statusCode, mappings: after.body.data?.mappings },
      'an array body is accepted and poisons GET').toEqual({ status: '4xx', mappings: before.body.data?.mappings });
  });

  it('REPRO 5: prototype keys are not ignored like other unknown keys', async () => {
    const state = await call('POST', { mappings: { constructor: SPARE_ASSET } });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
  });
});
