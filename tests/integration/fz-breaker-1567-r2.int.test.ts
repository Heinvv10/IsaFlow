/**
 * PR #1567 (999n) ledger-breaker round 2 repros, adopted: each forgery must be REFUSED, as app_user under withAuth's
 * role and claims and as production's postgres (fz_pg_ns: NOSUPERUSER, BYPASSRLS, a member of the fixture's postgres,
 * migration_admin and app_user, so it holds the table owner's rights). Seeding runs as the fixture's superuser.
 * N1/N2 status hop through NULL, G1 the balance-check queue, X1 a journal moved into Demo, D1 the finality oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = 'aaaaaaaa-0000-0000-0000-000000000002';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEMO = '00000000-0000-0000-0000-000000000001';
const USER_A = '11111111-1111-1111-1111-111111111112';
const USER_B = '22222222-2222-2222-2222-222222222222';
const ACC = { sal: 'aaaaaaaa-0000-0000-0000-0000000002a1', bank: 'aaaaaaaa-0000-0000-0000-0000000002a2', paye: 'aaaaaaaa-0000-0000-0000-0000000002a3' };
const EMP = ['aaaaaaaa-0000-0000-0000-0000000002e1', 'aaaaaaaa-0000-0000-0000-0000000002e2'];
const YEAR = 2100 + Math.floor(Math.random() * 800);
let month = 0;

beforeAll(async () => {
  await su.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fz_pg_ns') THEN CREATE ROLE fz_pg_ns NOLOGIN NOSUPERUSER INHERIT BYPASSRLS; END IF;
  END $$`);
  await su.query('GRANT postgres, migration_admin, app_user TO fz_pg_ns');
  await su.query("INSERT INTO users (id, email) VALUES ($1, 'fz-r2a@example.test'), ($2, 'fz-r2b@example.test') ON CONFLICT DO NOTHING", [USER_A, USER_B]);
  await su.query("INSERT INTO companies (id, name) VALUES ($1, 'FZ R2 A'), ($2, 'FZ R2 B') ON CONFLICT DO NOTHING", [A, B]);
  await su.query('INSERT INTO company_users (company_id, user_id) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [A, USER_A, B, USER_B]);
  await su.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance) VALUES
    ($2, $1, '6000', 'Salaries', 'expense', 'debit'), ($3, $1, '1000', 'Bank', 'asset', 'debit'),
    ($4, $1, '2200', 'PAYE', 'liability', 'credit') ON CONFLICT DO NOTHING`, [A, ACC.sal, ACC.bank, ACC.paye]);
  await su.query(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date) VALUES
    ($2, $1, 'E1', 'Ann', 'One', '2025-01-01'), ($3, $1, 'E2', 'Bob', 'Two', '2025-01-01') ON CONFLICT DO NOTHING`, [A, EMP[0], EMP[1]]);
}, 60_000);
afterAll(async () => {
  await su.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [A]);
  await su.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [[A, DEMO]]);
  await su.query('DELETE FROM payroll_employees WHERE company_id = $1', [A]);
  await su.query('DELETE FROM gl_accounts WHERE company_id = $1', [A]);
  await su.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A, B]]);
  await su.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
  await su.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
  await su.end();
});

type Who = 'app_user' | 'postgres' | 'app_user_tenant_b';
async function as(who: Who, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${who === 'postgres' ? 'fz_pg_ns' : 'app_user'}`);
    expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
    if (who !== 'postgres') {
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who === 'app_user' ? USER_A : USER_B, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [who === 'app_user' ? A : B]);
    }
    await fn(c);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const one = async (q: string, p: unknown[] = []) => (await su.query(q, p)).rows[0];
async function mkJournal(date: string, source = 'auto_payroll'): Promise<string> {
  const j = (await one(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
    VALUES ($1, 'fz payroll', $2, 'draft', $3, $4) RETURNING id`, [date, source, USER_A, A])).id as string;
  await su.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES
    ($1, $2, 1000, 0, $5), ($1, $3, 0, 200, $5), ($1, $4, 0, 800, $5)`, [j, ACC.sal, ACC.paye, ACC.bank, A]);
  await su.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [j]);
  return j;
}
async function finalRun(status: 'approved' | 'calculated' = 'approved'): Promise<{ run: string; je: string }> {
  month += 1;
  const y = YEAR + Math.floor(month / 12); const m = (month % 12) + 1;
  const je = await mkJournal(`${y}-${String(m).padStart(2, '0')}-28`);
  const run = (await one(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross, total_paye, total_net, employee_count)
    VALUES ($1, $2, $3, 'calculated', make_date($3, $2, 28), 1000, 200, 800, 2) RETURNING id`, [A, m, y])).id as string;
  await su.query('INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, paye, net_pay) VALUES ($1, $2, 600, 120, 480), ($1, $3, 400, 80, 320)', [run, EMP[0], EMP[1]]);
  if (status === 'approved') await su.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now(), journal_entry_id = $2 WHERE id = $1", [run, je]);
  return { run, je };
}
const journal = async (je: string) => one(`SELECT e.status, count(l.id)::int AS n, COALESCE(sum(l.debit),0)::text AS dr, COALESCE(sum(l.credit),0)::text AS cr
  FROM gl_journal_entries e LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id WHERE e.id = $1 GROUP BY e.status`, [je]);
const INTACT = { status: 'posted', n: 3, dr: '1000.00', cr: '1000.00' };

describe('999n breaker round 2: refused', () => {
  for (const who of ['app_user', 'postgres'] as const) {
    it(`N1 [${who}]: posted -> NULL, rewrite R1000 -> R1, NULL -> posted is refused at the first step`, async () => {
      const { je } = await finalRun();
      await expect(as(who, async (c) => {
        await c.query('UPDATE gl_journal_entries SET status = NULL WHERE id = $1', [je]);
        await c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [je]);
        await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1, 0, $4), ($1, $3, 0, 1, $4)', [je, ACC.sal, ACC.bank, A]);
        await c.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
      })).rejects.toThrow(/leaves posted only to reversed|status cannot be NULL/);
      expect(await journal(je)).toEqual(INTACT);
    });
    it(`N2 [${who}]: a NULL status cannot take the payroll journal out of force so the final run unlinks it`, async () => {
      const { run, je } = await finalRun();
      await expect(as(who, async (c) => {
        await c.query('UPDATE gl_journal_entries SET status = NULL WHERE id = $1', [je]);
        await c.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [run]);
      })).rejects.toThrow(/leaves posted only to reversed|status cannot be NULL/);
      expect((await one('SELECT journal_entry_id AS j FROM payroll_run_headers WHERE id = $1', [run])).j).toBe(je);
    });
    it(`N3 [${who}]: no other move out of posted or reversed (reversed -> posted, posted -> draft); posted -> reversed is allowed`, async () => {
      const je = await mkJournal('2026-03-12', 'manual');
      await expect(as(who, (c) => c.query("UPDATE gl_journal_entries SET status = 'draft' WHERE id = $1", [je]))).rejects.toThrow(/leaves posted only to reversed/);
      await as(who, (c) => c.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [je]));
      await expect(as(who, (c) => c.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]))).rejects.toThrow(/leaves posted only to reversed/);
    });
    it(`G1 [${who}]: a born-posted one-sided journal is refused even after the old GUC list is cleared, and the queue is out of reach`, async () => {
      const je = (await one('SELECT gen_random_uuid() AS id')).id as string;
      await expect(as(who, async (c) => {
        await c.query(`INSERT INTO gl_journal_entries (id, entry_date, description, source, status, created_by, company_id)
          VALUES ($1, '2026-03-12', 'forged', 'manual', 'posted', $2, $3)`, [je, USER_A, A]);
        await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 9999, 0, $3)', [je, ACC.sal, A]);
        await c.query("SELECT set_config('isaflow.fz_unchecked_journals', '', true)");
      })).rejects.toThrow(/does not balance/);
      expect((await one('SELECT count(*)::int AS n FROM gl_journal_entries WHERE id = $1', [je])).n).toBe(0);
      if (who === 'app_user') {
        await expect(as(who, (c) => c.query('DELETE FROM gl_journal_balance_queue'))).rejects.toThrow(/permission denied/);
        await expect(as(who, (c) => c.query('INSERT INTO gl_journal_balance_queue VALUES (txid_current(), gen_random_uuid())'))).rejects.toThrow(/permission denied/);
      }
    });
  }
  it('X1 [postgres]: a real company\'s posted journal cannot be moved into Demo (and so never reaches the Demo DELETE exemption)', async () => {
    const je = await mkJournal('2026-03-10', 'manual');
    await expect(as('postgres', async (c) => {
      await c.query('UPDATE gl_journal_entries SET company_id = $2 WHERE id = $1', [je, DEMO]);
      await c.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]);
    })).rejects.toThrow(/keeps its company/);
    expect((await one('SELECT count(*)::int AS n FROM gl_journal_entries WHERE id = $1', [je])).n).toBe(1);
  });
  it('X1b [postgres]: a Demo-company line inside a real company\'s posted journal is not deletable (the ENTRY\'s company decides)', async () => {
    const je = await mkJournal('2026-03-11', 'manual');
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO companies (id, name) VALUES ($1, 'Demo') ON CONFLICT DO NOTHING", [DEMO]);
      const acct = (await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
        VALUES ($1, 'FZ-R2', 'FZ demo', 'liability', 'credit') RETURNING id`, [DEMO])).rows[0].id;
      await c.query('UPDATE gl_journal_lines SET company_id = $2, gl_account_id = $3 WHERE journal_entry_id = $1 AND credit = 800', [je, DEMO, acct]);
      await c.query('SET LOCAL ROLE fz_pg_ns');
      await expect(c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND company_id = $2', [je, DEMO])).rejects.toThrow(/cannot be added or removed/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await journal(je)).toEqual({ status: 'posted', n: 3, dr: '1000.00', cr: '1000.00' });
  });
  it('X1e/S1 [app_user, tenant B]: a line in a journal tenant B cannot see (A\'s posted journal) is neither added nor removed: it fails closed', async () => {
    const je = await mkJournal('2026-03-13', 'manual');
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      const acct = (await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
        VALUES ($1, 'FZ-B1', 'FZ B', 'expense', 'debit') RETURNING id`, [B])).rows[0].id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1, 0, $3)', [je, acct, B]);
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_B, role: 'authenticated' })]);
      await c.query('SAVEPOINT d');
      await expect(c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND company_id = $2', [je, B])).rejects.toThrow(/cannot see/);
      await c.query('ROLLBACK TO SAVEPOINT d');
      await expect(c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1, 0, $3)', [je, acct, B]))
        .rejects.toThrow(/cannot see/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('S2 [a tenant-B caller]: the balance check\'s error gives a caller who cannot see the journal no id and no totals', async () => {
    const je = await mkJournal('2026-03-14', 'manual');
    const c = await su.connect();
    let message = '';
    try {
      await c.query('BEGIN');
      const acct = (await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
        VALUES ($1, 'FZ-B2', 'FZ B', 'expense', 'debit') RETURNING id`, [B])).rows[0].id;
      // Reach the deferred check from a caller who cannot see A's journal: the line-set rule (S1) and app_user's RLS
      // would refuse first. So, inside this rolled-back transaction, the rule is switched off and the line is written
      // by fz_s2: a throwaway role that is not RLS-bypassing, not app_service, and has a permissive policy of its own.
      await c.query('ALTER TABLE gl_journal_lines DISABLE TRIGGER trg_gl_jl_posted_set_frozen');
      await c.query('CREATE ROLE fz_s2 NOLOGIN');
      await c.query('GRANT SELECT, INSERT ON gl_journal_lines, gl_journal_entries, gl_accounts TO fz_s2');
      await c.query('CREATE POLICY fz_s2_all ON gl_journal_lines TO fz_s2 USING (true) WITH CHECK (true)');
      await c.query('SET LOCAL ROLE fz_s2');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_B, role: 'authenticated' })]);
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 7, 0, $3)', [je, acct, B]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE').catch((e: Error) => { message = e.message; });
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(message).toBe('gl_journal_entries: a posted journal does not balance');
    expect(message).not.toContain(je);
    expect(message).not.toMatch(/debit|credit|1007|1000/);
  });
  for (const who of ['app_user_tenant_b', 'postgres'] as const) {
    it(`M1 [${who}]: a line cannot be moved into another journal unless both are visible drafts of its own company`, async () => {
      const ja = await mkJournal('2026-03-15', 'manual');
      const c = await su.connect();
      try {
        await c.query('BEGIN');
        const acct = (await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
          VALUES ($1, 'FZ-M1', 'FZ B', 'expense', 'debit') RETURNING id`, [B])).rows[0].id;
        const draftB = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
          VALUES ('2026-03-15', 'b draft', 'manual', 'draft', $1, $2) RETURNING id`, [USER_B, B])).rows[0].id;
        const line = (await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
          VALUES ($1, $2, 5000, 0, $3) RETURNING id`, [draftB, acct, B])).rows[0].id;
        await c.query(`SET LOCAL ROLE ${who === 'postgres' ? 'fz_pg_ns' : 'app_user'}`);
        if (who !== 'postgres') await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_B, role: 'authenticated' })]);
        await expect(c.query('UPDATE gl_journal_lines SET journal_entry_id = $2 WHERE id = $1', [line, ja])).rejects.toThrow(who === 'postgres' ? /amounts are frozen|moves only between draft journals/ : /moves only between draft journals/);
      } finally { await c.query('ROLLBACK'); c.release(); }
      expect(await journal(ja)).toEqual(INTACT);
    });
  }
  it('M1c [app_user]: a line moves only into a DRAFT, not into a visible journal of its own company in any other state (a legacy NULL status)', async () => {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE gl_journal_entries DROP CONSTRAINT gl_journal_entries_status_not_null');
      await c.query('ALTER TABLE gl_journal_entries DISABLE TRIGGER trg_gl_je_status_not_null');
      const legacy = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
        VALUES ('2026-03-17', 'fz legacy', 'manual', NULL, $1, $2) RETURNING id`, [USER_A, A])).rows[0].id;
      const draftA = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
        VALUES ('2026-03-17', 'a draft', 'manual', 'draft', $1, $2) RETURNING id`, [USER_A, A])).rows[0].id;
      const line = (await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
        VALUES ($1, $2, 10, 0, $3) RETURNING id`, [draftA, ACC.sal, A])).rows[0].id;
      await c.query('ALTER TABLE gl_journal_entries ENABLE ALWAYS TRIGGER trg_gl_je_status_not_null');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_A, role: 'authenticated' })]);
      await expect(c.query('UPDATE gl_journal_lines SET journal_entry_id = $2 WHERE id = $1', [line, legacy])).rejects.toThrow(/moves only between draft journals/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('M1b: a line move re-checks both journals at COMMIT (second line of defence, the move rule switched off)', async () => {
    const ja = await mkJournal('2026-03-16', 'manual');
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE gl_journal_lines DISABLE TRIGGER trg_gl_jl_posted_frozen');
      const draftA = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
        VALUES ('2026-03-16', 'a draft', 'manual', 'draft', $1, $2) RETURNING id`, [USER_A, A])).rows[0].id;
      const line = (await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
        VALUES ($1, $2, 5000, 0, $3) RETURNING id`, [draftA, ACC.sal, A])).rows[0].id;
      await c.query('SET LOCAL ROLE fz_pg_ns');
      await c.query('UPDATE gl_journal_lines SET journal_entry_id = $2 WHERE id = $1', [line, ja]);
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/does not balance/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await journal(ja)).toEqual(INTACT);
  });
  it('L: an app_service member (the isaflow_service login) is judged on the header itself, as its policies admit every row', async () => {
    const { run: openA } = await finalRun('calculated');
    const { run: finalA } = await finalRun();
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_service');
      expect((await c.query('SELECT public.payroll_run_final_state($1) AS f', [openA])).rows[0].f).toBe(false);
      expect((await c.query('SELECT public.payroll_run_final_state($1) AS f', [finalA])).rows[0].f).toBe(true);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('D1 [app_user, tenant B]: tenant B learns nothing of A\'s run finality, takes no lock on A\'s header, and its line write is refused', async () => {
    const { run: finalA } = await finalRun();
    const { run: openA } = await finalRun('calculated');
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_B, role: 'authenticated' })]);
      // Final and not final read the same to B: "final", fail closed.
      expect((await c.query('SELECT public.payroll_run_final_state($1) AS f', [finalA])).rows[0].f).toBe(true);
      expect((await c.query('SELECT public.payroll_run_final_state($1) AS f', [openA])).rows[0].f).toBe(true);
      // No FOR SHARE was taken: A's header updates at once under a short lock_timeout while B's transaction is open.
      const d = await su.connect();
      try {
        await d.query('BEGIN');
        await d.query("SET LOCAL lock_timeout = '1s'");
        await d.query('UPDATE payroll_run_headers SET updated_at = now() WHERE id = ANY($1)', [[finalA, openA]]);
        await d.query('ROLLBACK');
      } finally { d.release(); }
      await c.query('SAVEPOINT w');
      await expect(c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 1 WHERE run_id = $1', [openA])).rejects.toThrow(/figures are frozen/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    // EXECUTE is only for the line writers: a role without the grant cannot ask at all.
    await expect((async () => {
      const e = await su.connect();
      try {
        await e.query('BEGIN');
        await e.query('SET LOCAL ROLE supabase_read_only_user');
        await e.query('SELECT public.payroll_run_final_state($1)', [openA]);
      } finally { await e.query('ROLLBACK'); e.release(); }
    })()).rejects.toThrow(/permission denied/);
    // A's own user reads the truth.
    await as('app_user', async (cc) => {
      expect((await cc.query('SELECT public.payroll_run_final_state($1) AS f', [openA])).rows[0].f).toBe(false);
    });
  });
});
