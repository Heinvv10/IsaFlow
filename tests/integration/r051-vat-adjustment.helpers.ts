// Shared fixture for the R-051 integration tests (VAT adjustment approve / cancel).
// Each file calling useR051Fixture() gets its own companies, user and token.
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import actionRoute from '../../pages/api/accounting/vat-adjustments-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

export const company = crypto.randomUUID();
export const otherCompany = crypto.randomUUID();
export const user = crypto.randomUUID();
let token = '';
let seq = 0;

export type Out = { statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };

export async function act(action: 'approve' | 'cancel', id: string): Promise<Out> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; url: string };
  req.url = '/api/accounting/vat-adjustments-action';
  req.body = { action, id };
  const out = response();
  await actionRoute(req as never, out.res as never);
  return out.state as Out;
}

export async function seedAdjustment(owner = company, date = '2026-08-15'): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await pool.query(
    `INSERT INTO vat_adjustments(id,company_id,adjustment_number,adjustment_date,adjustment_type,amount,reason,created_by)
     VALUES($1,$2,$3,$4,'input',150,'R051 missed input VAT',$5)`,
    [id, owner, `R051-${id.slice(0, 8)}-${seq}`, date, user]);
  return id;
}

export async function adjustment(id: string) {
  return (await pool.query('SELECT status, gl_journal_entry_id FROM vat_adjustments WHERE id=$1', [id])).rows[0] as
    { status: string; gl_journal_entry_id: string | null };
}
/** Every journal the adjustment produced, draft or posted — found by its description, which names the number. */
export async function journals(id: string): Promise<Array<{ id: string; status: string }>> {
  return (await pool.query(
    `SELECT je.id, je.status FROM gl_journal_entries je
       JOIN vat_adjustments va ON je.description = 'VAT adjustment ' || va.adjustment_number
      WHERE va.id = $1 AND je.company_id = $2 AND je.source = 'auto_vat_adjustment'`,
    [id, company])).rows;
}

async function purge(): Promise<void> {
  await pool.query('DELETE FROM vat_period_locks WHERE company_id=$1', [company]);
  await pool.query('UPDATE vat_adjustments SET gl_journal_entry_id=NULL WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM vat_adjustments WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
  await pool.query('DELETE FROM users WHERE id=$1', [user]);
}

export function useR051Fixture(): void {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO companies(id,name,vat_period,vat_system_type) VALUES($1,$2,'bi-monthly','invoice'),($3,$4,'bi-monthly','invoice')`,
      [company, 'R051 owner', otherCompany, 'R051 other tenant']);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES($1,'R051VI','R051 VAT input','asset','debit',true,true,'vat_input'),
             ($1,'R051VO','R051 VAT output','liability','credit',true,true,'vat_output'),
             ($1,'R051AE','R051 Admin expense','expense','debit',true,true,'admin_expense')`, [company]);
    token = await new SignJWT({ sub: user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60_000);

  afterAll(async () => {
    try { await purge(); } finally { await pool.end(); }
  }, 60_000);
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until some backend other than `exclude` is blocked by one of `blockers`, and return it.
 * Scoped by pid, never by statement text: this fixture database is shared.
 */
export async function waitBlocked(blockers: number[], exclude: number[] = []): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const rows = (await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[] AND NOT (pid = ANY($2::int[]))',
      [blockers, exclude])).rows as Array<{ pid: number }>;
    if (rows.length > 0) return rows[0]!.pid;
    await pause(25);
  }
  throw new Error(`nothing blocked by ${blockers.join(',')} within 5s`);
}
