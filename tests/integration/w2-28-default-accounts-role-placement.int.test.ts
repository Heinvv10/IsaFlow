// PR #593 breaker round 2 — role placement repros. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import { getSystemAccount, clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { ensureOpeningBalanceEquityAccount } from '../../src/modules/accounting/services/gl/openingBalanceEquityService';
import { isReportVisibleLeaf } from '../../src/modules/accounting/services/gl/isReportVisibleLeaf';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID(); const B = randomUUID();
const ADMIN = randomUUID(); const VIEWER = randomUUID(); const ADMIN_B = randomUUID();
const H1000 = randomUUID(); const BANK = randomUUID(); const BANK2 = randomUUID(); const AR = randomUUID();
const AR2 = randomUUID(); const INV = randomUUID(); const H3000 = randomUUID(); const SC = randomUUID();
const RE = randomUUID(); const OBE = randomUUID(); const B_BANK = randomUUID(); const B_ASSET = randomUUID();

type State = { statusCode: number; body: { data?: { mappings?: Record<string, string> }; message?: string } };

describeIfDb('PR #593 breaker round 2 — role placement', () => {
  let pool: Pool;
  const tokens: Record<string, string> = {};
  async function call(user: string, company: string, method: string, body?: Record<string, unknown>): Promise<State> {
    const req = request({ 'sb-access-token': tokens[user]!, active_company_id: company }, method) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/default-accounts';
    const out = response();
    await (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return out.state as State;
  }
  const ins = (co: string, id: string, code: string, type: string, sub: string | null, sys: boolean,
    level = 3, parent: string | null = null) => pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
       normal_balance, is_active, is_system_account, level, parent_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10)`,
    [id, co, code, `BRK2 ${code}`, type, sub, ['asset', 'expense'].includes(type) ? 'debit' : 'credit', sys, level, parent]);
  const row = async (id: string) => (await pool.query(
    'SELECT account_subtype, is_system_account FROM gl_accounts WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    for (const [co, name] of [[A, 'BRK593b A'], [B, 'BRK593b B']]) {
      await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [co, name]);
    }
    for (const [u, co, role] of [[ADMIN, A, 'admin'], [VIEWER, A, 'viewer'], [ADMIN_B, B, 'admin']]) {
      await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
        [u, `brk593b-${u}@isaflow.test`]);
      await pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [co, u, role]);
      tokens[u] = await new SignJWT({ sub: u, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    }
  });
  beforeEach(async () => {
    for (const co of [A, B]) {
      await pool.query('DELETE FROM app_settings WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1 AND parent_account_id IS NOT NULL', [co]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
    }
    await ins(A, H1000, '1000', 'asset', null, false, 1);             // header with children
    await ins(A, BANK, '1110', 'asset', 'bank', true, 3, H1000);
    await ins(A, BANK2, '1111', 'asset', 'bank', false, 3, H1000);
    await ins(A, AR, '1120', 'asset', 'receivable', true, 3, H1000);
    await ins(A, AR2, '1121', 'asset', null, false, 3, H1000);
    await ins(A, INV, '1300', 'asset', 'inventory', false, 3, H1000);
    await ins(A, H3000, '3000', 'equity', null, false, 1);            // header with children
    await ins(A, SC, '3100', 'equity', 'equity', false, 3, H3000);    // Share Capital
    await ins(A, RE, '3200', 'equity', 'retained_earnings', true, 3, H3000);
    await ins(A, OBE, '3300', 'equity', 'opening_balance_equity', true, 3, H3000);
    await ins(B, B_BANK, '1110', 'asset', 'bank', true);
    await ins(B, B_ASSET, '1125', 'asset', null, false);
    clearSystemAccountCache(A); clearSystemAccountCache(B);
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      for (const co of [A, B]) {
        for (const t of ['app_settings', 'company_users']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1 AND parent_account_id IS NOT NULL', [co]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [co]);
        await pool.query('DELETE FROM companies WHERE id = $1', [co]);
      }
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [[ADMIN, VIEWER, ADMIN_B]]);
    } finally { await pool.end(); }
  });

  it('REPRO 1: the page saved as loaded reverts a role another user moved meanwhile (200)', async () => {
    const loaded = await call(ADMIN, A, 'GET');
    expect(loaded.body.data?.mappings?.primary_bank).toBe(BANK);
    // Second tab / second user moves the primary bank.
    expect((await call(ADMIN, A, 'POST', { mappings: { primary_bank: BANK2 }, loaded: { primary_bank: BANK } })).statusCode).toBe(200);
    // First tab changes ONLY receivable and saves the page it loaded (the UI posts the whole map).
    const save = await call(ADMIN, A, 'POST', { mappings: { ...loaded.body.data!.mappings, accounts_receivable: AR2 } });
    clearSystemAccountCache(A);
    const bank = (await getSystemAccount('bank', A)).id;
    expect({ status: save.statusCode, bank },
      'a save that did not touch primary_bank moved it back to the stale value').not.toEqual({ status: 200, bank: BANK });
  });

  it('REPRO 2: a header account (level 1, has children) is accepted as Opening Balance Equity / primary bank', async () => {
    const obe = await call(ADMIN, A, 'POST', { mappings: { opening_balance_equity: H3000 } });
    const bank = await call(ADMIN, A, 'POST', { mappings: { primary_bank: H1000 } });
    clearSystemAccountCache(A);
    const contra = await ensureOpeningBalanceEquityAccount(A);   // MCP set_opening_balance default contra
    const visible = await isReportVisibleLeaf(A, contra.id, 1, 'equity');
    expect({ obe: obe.statusCode, bank: bank.statusCode, contra: contra.accountCode, contraOnBalanceSheet: visible,
      bankHolder: (await getSystemAccount('bank', A)).accountCode },
    'roles were placed on header accounts the balance sheet does not show').toEqual({
      obe: 400, bank: 400, contra: '3300', contraOnBalanceSheet: true, bankHolder: '1110' });
  });

  it('REPRO 3a: OBE pointed at Share Capital rewrites its classification (200)', async () => {
    const res = await call(ADMIN, A, 'POST', { mappings: { opening_balance_equity: SC } });
    expect({ status: res.statusCode, sc: (await row(SC)).account_subtype },
      'Share Capital lost its equity subtype and became the opening-balance clearing account')
      .not.toEqual({ status: 200, sc: 'opening_balance_equity' });
  });

  it('REPRO 3b: RE/OBE swap turns the retained-earnings account into the OBE clearing account (200)', async () => {
    const res = await call(ADMIN, A, 'POST', { mappings: { retained_earnings: SC, opening_balance_equity: RE } });
    expect({ status: res.statusCode, re: (await row(RE)).account_subtype },
      'the account holding accumulated profits is now the clearing account that should net to zero')
      .not.toEqual({ status: 200, re: 'opening_balance_equity' });
  });

  it('REPRO 3c: primary bank pointed at Inventory rewrites inventory → bank (200)', async () => {
    const res = await call(ADMIN, A, 'POST', { mappings: { primary_bank: INV } });
    expect({ status: res.statusCode, inv: (await row(INV)).account_subtype },
      'the inventory account is now a bank account').not.toEqual({ status: 200, inv: 'bank' });
  });

  it('CONTROL: viewer 403, cross-tenant account refused, tenant B untouched, GET does not leak B', async () => {
    const viewer = await call(VIEWER, A, 'POST', { mappings: { primary_bank: BANK2 } });
    const viewerGet = await call(VIEWER, A, 'GET');
    const cross = await call(ADMIN, A, 'POST', { mappings: { primary_bank: B_ASSET } });
    const wrongCo = await call(ADMIN, B, 'POST', { mappings: { primary_bank: B_ASSET } });
    const getA = await call(ADMIN, A, 'GET');
    expect({
      viewer: viewer.statusCode, viewerGet: viewerGet.statusCode, cross: cross.statusCode, wrongCo: wrongCo.statusCode,
      bankA: (await row(BANK)).is_system_account, bAsset: await row(B_ASSET), bBank: (await row(B_BANK)).is_system_account,
      leak: JSON.stringify(getA.body).includes(B_BANK),
    }).toEqual({
      viewer: 403, viewerGet: 200, cross: 400, wrongCo: 403,
      bankA: true, bAsset: { account_subtype: null, is_system_account: false }, bBank: true, leak: false,
    });
  });
});
