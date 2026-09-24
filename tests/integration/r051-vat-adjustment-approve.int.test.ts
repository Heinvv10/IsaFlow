// R-051 (residual) — approving a VAT adjustment posts its journal exactly once,
// and a refused approval writes nothing.
//
// approveVATAdjustment read the adjustment's status with no lock, created and
// POSTED the journal, then stamped status='approved' with an UPDATE that did not
// re-check the status. Two approvals arriving together both read 'draft' and
// both posted a journal: the VAT figure moved twice. And the route answers every
// failure 400, which withAuth COMMITs — so a journal the posting guard refused
// (a locked VAT period) left its draft journal behind.
//
// Every case runs through the real route (withAuth, app_user, RLS) and asserts
// the outcome: the status, the adjustment row, and the journals that exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import actionRoute from '../../pages/api/accounting/vat-adjustments-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '@/lib/als';
import { approveVATAdjustment, VatAdjustmentRefusal } from '@/modules/accounting/services/reports/vatAdjustmentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
let token = '';
let seq = 0;

type Out = { statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } } };

async function act(action: 'approve' | 'cancel', id: string): Promise<Out> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; url: string };
  req.url = '/api/accounting/vat-adjustments-action';
  req.body = { action, id };
  const out = response();
  await actionRoute(req as never, out.res as never);
  return out.state as Out;
}

async function seedAdjustment(owner = company, date = '2026-08-15'): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await pool.query(
    `INSERT INTO vat_adjustments(id,company_id,adjustment_number,adjustment_date,adjustment_type,amount,reason,created_by)
     VALUES($1,$2,$3,$4,'input',150,'R051 missed input VAT',$5)`,
    [id, owner, `R051-${id.slice(0, 8)}-${seq}`, date, user]);
  return id;
}

async function adjustment(id: string) {
  return (await pool.query('SELECT status, gl_journal_entry_id FROM vat_adjustments WHERE id=$1', [id])).rows[0] as
    { status: string; gl_journal_entry_id: string | null };
}
/** Every journal the adjustment produced, draft or posted — found by its description, which names the number. */
async function journals(id: string): Promise<Array<{ id: string; status: string }>> {
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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until some backend other than `exclude` is blocked by one of `blockers`, and return it.
 * Scoped by pid, never by statement text: this fixture database is shared.
 */
async function waitBlocked(blockers: number[], exclude: number[] = []): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const rows = (await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[] AND NOT (pid = ANY($2::int[]))',
      [blockers, exclude])).rows as Array<{ pid: number }>;
    if (rows.length > 0) return rows[0]!.pid;
    await pause(25);
  }
  throw new Error(`nothing blocked by ${blockers.join(',')} within 5s`);
}

describe('R-051: approving a VAT adjustment posts its journal once', () => {
  it('approves a draft: one posted journal, linked from the adjustment', async () => {
    const id = await seedAdjustment();

    const out = await act('approve', id);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const js = await journals(id);
    expect(js).toHaveLength(1);
    expect(js[0]!.status).toBe('posted');
    expect(await adjustment(id)).toEqual({ status: 'approved', gl_journal_entry_id: js[0]!.id });
  });

  it('a second approval is refused and posts nothing more', async () => {
    const id = await seedAdjustment();
    expect((await act('approve', id)).statusCode).toBe(200);

    const again = await act('approve', id);

    expect(again.statusCode, JSON.stringify(again.body)).toBe(400);
    expect(await journals(id)).toHaveLength(1);
  });

  it('two approvals raced together post exactly one journal', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await seedAdjustment();

      const results = await Promise.all([act('approve', id), act('approve', id)]);

      expect(results.map((r) => r.statusCode).sort(), `round ${round}`).toEqual([200, 400]);
      const js = await journals(id);
      expect(js, `round ${round}`).toHaveLength(1);
      expect((await adjustment(id)).gl_journal_entry_id).toBe(js[0]!.id);
    }
  });

  it('a second approval that read draft while the first was still in flight does not post again (deterministic)', async () => {
    // A date in a fiscal year this company does not have yet: the first approval creates it and
    // stalls uncommitted on the held row; the second then waits on the first's fiscal-year insert,
    // AFTER reading 'draft' and BEFORE minting its entry number — so on the defect it mints the next
    // number once the first commits, instead of colliding on uq_gl_je_company_entry_number.
    const id = await seedAdjustment(company, '2025-03-15');
    const holder = await pool.connect();
    let first: Promise<Out> | undefined;
    let second: Promise<Out> | undefined;
    try {
      await holder.query('BEGIN');
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await holder.query('SELECT 1 FROM vat_adjustments WHERE id=$1 FOR UPDATE', [id]);
      // The first approval runs until it needs the adjustment row, and waits there.
      first = act('approve', id);
      const firstPid = await waitBlocked([holderPid]);
      // The second starts while the first is uncommitted, and waits on it (or on the holder).
      second = act('approve', id);
      await waitBlocked([holderPid, firstPid], [firstPid]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const results = await Promise.all([first!, second!]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const js = await journals(id);
    expect(js).toHaveLength(1);
    expect((await adjustment(id)).gl_journal_entry_id).toBe(js[0]!.id);
  }, 30_000);

  it('an approval raced with a cancel ends consistent: approved with one journal, or cancelled with none', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await seedAdjustment();

      await Promise.all([act('approve', id), act('cancel', id)]);

      const state = await adjustment(id);
      const js = await journals(id);
      if (state.status === 'approved') {
        expect(js, `round ${round}`).toHaveLength(1);
      } else {
        expect(state.status, `round ${round}`).toBe('cancelled');
        expect(js, `round ${round}`).toHaveLength(0);
      }
    }
  });

  it('an approval the posting guard refuses (locked VAT period) leaves no journal behind', async () => {
    const id = await seedAdjustment(company, '2026-06-10');
    await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by)
       VALUES($1,'2026-05-01','2026-06-30',0,0,0,'2026-06-30',$2)`, [company, user]);

    const out = await act('approve', id);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await journals(id)).toHaveLength(0);
    expect(await adjustment(id)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('an approval refused at post (closed fiscal period) leaves no draft journal behind', async () => {
    const id = await seedAdjustment(company, '2024-07-10');
    await pool.query(
      `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,'R051 closed Jul 2024',99,2024,'2024-07-01','2024-07-31','closed')`, [company]);

    const out = await act('approve', id);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await journals(id)).toHaveLength(0);
    expect(await adjustment(id)).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it("answers 404 for another company's adjustment, and writes nothing", async () => {
    const foreign = await seedAdjustment(otherCompany);

    const out = await act('approve', foreign);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
    expect((await pool.query('SELECT status FROM vat_adjustments WHERE id=$1', [foreign])).rows[0].status).toBe('draft');
  });

  it('the company scope holds without RLS: the service refuses a foreign id on a BYPASSRLS connection', async () => {
    // The route runs as app_user, where RLS alone would hide the row; this pins the
    // service's own company_id predicate for callers that run without RLS (cron, admin).
    const foreign = await seedAdjustment(otherCompany);
    const c = await pool.connect();
    let caught: unknown;
    try {
      await c.query('BEGIN');
      await als.run({ client: c, userId: user, companyId: company, claims: {} } as never,
        () => approveVATAdjustment(company, foreign, user)).catch((e: unknown) => { caught = e; });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    expect(caught).toBeInstanceOf(VatAdjustmentRefusal);
    expect((caught as VatAdjustmentRefusal).kind).toBe('not_found');
  });

  it('answers 409 while another request holds the adjustment, and posts nothing', async () => {
    const id = await seedAdjustment();
    const c = await pool.connect();
    let out: Out;
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM vat_adjustments WHERE id=$1 FOR UPDATE', [id]);
      out = await act('approve', id);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect(await journals(id)).toHaveLength(0);
    expect((await adjustment(id)).status).toBe('draft');
  }, 30_000);
});
