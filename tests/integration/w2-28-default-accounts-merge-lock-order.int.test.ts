// PR #593 breaker round 2 — the save's lock order (all role rows FOR UPDATE, then the chosen
// account at UPDATE time) inverts an account merge's (ascending id, source + target). Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

let gate: { reached: () => void; release: Promise<void> } | null = null;
vi.mock('@/modules/accounting/services/gl/systemRoleCoverage', async (orig) => {
  const actual = await orig<typeof import('../../src/modules/accounting/services/gl/systemRoleCoverage')>();
  return {
    ...actual,
    getSystemRoleCoverage: async (...args: Parameters<typeof actual.getSystemRoleCoverage>) => {
      const out = await actual.getSystemRoleCoverage(...args);
      if (gate) { const g = gate; gate = null; g.reached(); await g.release; }
      return out;
    },
  };
});
import defaultAccounts from '../../pages/api/accounting/default-accounts';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;
const A = randomUUID(); const USER = randomUUID();
// Merge source must sort BEFORE the target so lockGlAccountsForUpdate takes it first.
const SRC = '00000000-0000-4000-8000-' + randomUUID().slice(-12);
const TGT = 'ffffffff-ffff-4fff-bfff-' + randomUUID().slice(-12);

describeIfDb('PR #593 breaker round 2 — lock order vs account merge', () => {
  let pool: Pool; let token = '';
  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [A, 'BRK593b lock']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [USER, `brk593bl-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    for (const [id, code, sub, sys] of [[TGT, '1110', 'bank', true], [SRC, '1111', null, false]] as const) {
      await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account, level) VALUES ($1,$2,$3,$3,'asset',$4,'debit',true,$5,3)`, [id, A, code, sub, sys]);
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['app_settings', 'gl_accounts', 'company_users']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [A]);
      await pool.query('DELETE FROM companies WHERE id = $1', [A]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally { await pool.end(); }
  });

  it('REPRO 5: save moving bank to SRC while SRC is merged into the bank → deadlock, one side 40P01', async () => {
    let reached!: () => void; let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    gate = { reached, release: new Promise<void>((r) => { release = r; }) };

    const req = request({ 'sb-access-token': token, active_company_id: A }, 'POST') as never as { body: unknown; url: string };
    req.body = { mappings: { primary_bank: SRC }, loaded: { primary_bank: TGT } };
    req.url = '/api/accounting/default-accounts';
    const out = response();
    const save = (defaultAccounts as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    await reachedP;   // save holds FOR UPDATE on TGT (the bank role row)

    // mergeAccounts(SRC → TGT): lockGlAccountsForUpdate — ascending id, one row at a time, lock_timeout 5s.
    const merge = await pool.connect();
    let mergeErr = '';
    const mergeP = (async () => {
      try {
        await merge.query('BEGIN');
        await merge.query("SET LOCAL lock_timeout = '5s'");
        for (const id of [SRC, TGT].sort()) {
          await merge.query('SELECT id FROM gl_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, A]);
        }
        await merge.query('ROLLBACK');
      } catch (e) {
        mergeErr = (e as { code?: string }).code ?? String(e);
        await merge.query('ROLLBACK');
      } finally { merge.release(); }
    })();
    await new Promise((r) => setTimeout(r, 300));   // merge now holds SRC, waits on TGT
    release();
    await Promise.all([save, mergeP]);
    expect({ save: out.state.statusCode, mergeErr }, 'one side was killed by the deadlock detector')
      .toEqual({ save: 200, mergeErr: '' });
  }, 20_000);
});
