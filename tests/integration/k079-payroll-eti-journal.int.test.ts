/**
 * K-079 — a pay run claiming ETI must post a balanced journal.
 *
 * Driven through the real route, POST /api/payroll/runs/[id]/approve: withAuth
 * (app_user, RLS), withCsrf, withWriteAccess, approvePayrollRun, the builder
 * and the GL poster. Nothing is mocked.
 *
 * Hein, 2026-09-26: ETI is netted off labour cost and capped at the run's
 * PAYE (etiUsed = min(eti, paye)), so CR 2140 = paye − etiUsed, which is the
 * EMP201 PAYE payable. withAuth COMMITs on a 4xx, so a refusal must leave the
 * run exactly as it was — not 'approved' with no journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const admin = crypto.randomUUID();
let token = '';

const REQUIRED = ['5200', '2140', '2150', '2160', '1110'];

interface Totals { gross: number; paye: number; uif: number; sdl: number; eti: number; net: number }

async function run(company: string, month: number, t: Totals): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers(company_id,period_month,period_year,status,total_gross,total_taxable,
       total_paye,total_uif,total_sdl,total_eti,total_net,employee_count)
     VALUES($1,$2,2026,'calculated',$3,$3,$4,$5,$6,$7,$8,1) RETURNING id`,
    [company, month, t.gross, t.paye, t.uif, t.sdl, t.eti, t.net])).rows[0]!.id;
}

async function callApprove(runId: string, company = companyA) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST', runId) as never as {
    url: string;
  };
  req.url = `/api/payroll/runs/${runId}/approve`;
  const result = response();
  await approve(req as never, result.res);
  return result.state;
}

async function header(runId: string) {
  return (await pool.query<{ status: string; journal_entry_id: string | null }>(
    'SELECT status, journal_entry_id FROM payroll_run_headers WHERE id=$1', [runId])).rows[0]!;
}

/** The posted journal's lines by account code, and the entry's status. */
async function journal(journalId: string) {
  const { rows } = await pool.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.account_code AS code, l.debit, l.credit
       FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.journal_entry_id = $1`, [journalId]);
  const entry = (await pool.query<{ status: string }>(
    'SELECT status FROM gl_journal_entries WHERE id=$1', [journalId])).rows[0]!;
  const by = (code: string) => rows.filter((r) => r.code === code);
  const sum = (k: 'debit' | 'credit') => Math.round(rows.reduce((s, r) => s + Number(r[k]), 0) * 100) / 100;
  return { rows, by, debit: sum('debit'), credit: sum('credit'), status: entry.status };
}

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'K079 A'], [companyB, 'K079 B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    for (const code of REQUIRED) {
      const type = code === '5200' ? 'expense' : code === '1110' ? 'asset' : 'liability';
      const normal = type === 'liability' ? 'credit' : 'debit';
      await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1,$2,$3,$4,$5,1)`, [id, code, `K079 ${code}`, type, normal]);
    }
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  for (const c of [companyA, companyB]) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [c, admin]);
  }
  token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  const ids = [companyA, companyB];
  try {
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('K-079: approving a run that claims ETI', () => {
  it('ETI below PAYE: posts a balanced journal with 2140 = paye − eti and links it to the run', async () => {
    // employee UIF 750 + employer UIF 750; net = gross − paye − employee UIF.
    const id = await run(companyA, 3, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 500, net: 79250 });
    const res = await callApprove(id);
    expect(res.statusCode).toBe(200);

    const h = await header(id);
    expect(h.status).toBe('approved');
    expect(h.journal_entry_id).not.toBeNull();

    const j = await journal(h.journal_entry_id!);
    expect(j.status).toBe('posted');
    expect(j.debit).toBe(j.credit);
    expect(j.by('2140').map((l) => Number(l.credit))).toEqual([19500]);
    expect(j.by('5200').map((l) => Number(l.debit))).toEqual([100000 + 750 + 1000 - 500]);
  });

  it('ETI above PAYE: books only the ETI PAYE can absorb, and still posts balanced', async () => {
    // Low-wage staff: PAYE 300, ETI 2 500, SDL-exempt. EMP201 payable is 0.
    const id = await run(companyA, 4, { gross: 10000, paye: 300, uif: 200, sdl: 0, eti: 2500, net: 9600 });
    const res = await callApprove(id);
    expect(res.statusCode).toBe(200);

    const h = await header(id);
    expect(h.status).toBe('approved');
    const j = await journal(h.journal_entry_id!);
    expect(j.debit).toBe(j.credit);
    // 2140 nets to zero, so no PAYE line; labour is reduced by the 300 used.
    expect(j.by('2140').reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)).toBe(0);
    expect(j.by('5200').map((l) => Number(l.debit))).toEqual([10000 + 100 - 300]);
    expect(j.by('1110').map((l) => Number(l.credit))).toEqual([9600]);
  });

  it('no ETI: the journal is unchanged — 2140 carries the full PAYE', async () => {
    const id = await run(companyA, 5, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 0, net: 79250 });
    const res = await callApprove(id);
    expect(res.statusCode).toBe(200);

    const j = await journal((await header(id)).journal_entry_id!);
    expect(j.debit).toBe(j.credit);
    expect(j.by('2140').map((l) => Number(l.credit))).toEqual([20000]);
    expect(j.by('5200').map((l) => Number(l.debit))).toEqual([101750]);
  });

  it("another tenant's run is refused and left exactly as it was", async () => {
    const foreign = await run(companyB, 3, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 500, net: 79250 });
    const res = await callApprove(foreign, companyA);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);

    expect(await header(foreign)).toEqual({ status: 'calculated', journal_entry_id: null });
    const { rows } = await pool.query('SELECT 1 FROM gl_journal_entries WHERE company_id=$1', [companyB]);
    expect(rows).toHaveLength(0);
  });

  it('a status approval refuses is a 400 and leaves the run as it was', async () => {
    const id = await run(companyA, 7, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 500, net: 79250 });
    await pool.query("UPDATE payroll_run_headers SET status='cancelled' WHERE id=$1", [id]);
    const res = await callApprove(id);
    expect(res.statusCode).toBe(400);
    expect(await header(id)).toEqual({ status: 'cancelled', journal_entry_id: null });
  });

  it('a failure AFTER the status write is a 500 and rolls the approval back', async () => {
    // A closed period is not a plan blocker: the GL poster refuses it after
    // approvePayrollRun has written 'approved'. A 400 here would COMMIT that.
    // Earlier cases auto-create the fiscal year, so close August where it exists.
    const closed = await pool.query(
      `UPDATE fiscal_periods SET status='closed'
        WHERE company_id=$1 AND start_date <= DATE '2026-08-31' AND end_date >= DATE '2026-08-31'`, [companyA]);
    if (closed.rowCount === 0) {
      await pool.query(
        `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
         VALUES($1,'K079 Aug 2026',8,2026,DATE '2026-08-01',DATE '2026-08-31','closed')`, [companyA]);
    }
    const id = await run(companyA, 8, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 500, net: 79250 });
    const res = await callApprove(id);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await header(id)).toEqual({ status: 'calculated', journal_entry_id: null });
  });

  it('a run the journal cannot post for is refused BEFORE it is marked approved', async () => {
    // R2 000 of voluntary deductions and no 2175 account: the plan blocks.
    const id = await run(companyA, 6, { gross: 100000, paye: 20000, uif: 1500, sdl: 1000, eti: 500, net: 77250 });
    const res = await callApprove(id);
    expect(res.statusCode).toBe(400);
    expect(await header(id)).toEqual({ status: 'calculated', journal_entry_id: null });
  });
});
