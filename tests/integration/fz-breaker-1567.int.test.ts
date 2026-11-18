/**
 * PR #1567 (999n) ledger-breaker repros, adopted: each forgery must be REFUSED, run as app_user under withAuth's
 * role and claims, and again as production's postgres: a NOSUPERUSER, BYPASSRLS role holding the table owner's
 * rights (here fz_pg_ns, a non-superuser member of the fixture's postgres, migration_admin and app_user). Seeding
 * runs as the fixture's superuser, which 999n exempts. B10 documents the stated limit: the owner can DISABLE a
 * trigger (wave 7 moves table ownership).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const su = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(async () => {
  // Everything the suite made, as the superuser (999n exempts it): the deploy-checks guard judges the shared fixture.
  await su.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [A]);
  await su.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [A]);
  await su.query('DELETE FROM payroll_employees WHERE company_id = $1', [A]);
  await su.query('DELETE FROM gl_accounts WHERE company_id = $1', [A]);
  await su.query('DELETE FROM company_users WHERE company_id = $1', [A]);
  await su.query('DELETE FROM companies WHERE id = $1', [A]);
  await su.end();
});

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const ACC = { sal: 'aaaaaaaa-0000-0000-0000-0000000000a1', bank: 'aaaaaaaa-0000-0000-0000-0000000000a2', paye: 'aaaaaaaa-0000-0000-0000-0000000000a3' };
const EMP = ['aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e2'];
const YEAR = 2100 + Math.floor(Math.random() * 800);
let month = 0;

beforeAll(async () => {
  await su.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fz_pg_ns') THEN
      CREATE ROLE fz_pg_ns NOLOGIN NOSUPERUSER INHERIT BYPASSRLS;
    END IF;
  END $$`);
  await su.query('GRANT postgres, migration_admin, app_user TO fz_pg_ns');
  await su.query("INSERT INTO users (id, email) VALUES ($1, 'fz@example.test') ON CONFLICT DO NOTHING", [USER_A]);
  await su.query("INSERT INTO companies (id, name) VALUES ($1, 'FZ Break A') ON CONFLICT DO NOTHING", [A]);
  await su.query('INSERT INTO company_users (company_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [A, USER_A]);
  await su.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance) VALUES
    ($2, $1, '6000', 'Salaries', 'expense', 'debit'), ($3, $1, '1000', 'Bank', 'asset', 'debit'),
    ($4, $1, '2200', 'PAYE', 'liability', 'credit') ON CONFLICT DO NOTHING`, [A, ACC.sal, ACC.bank, ACC.paye]);
  await su.query(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date) VALUES
    ($2, $1, 'E1', 'Ann', 'One', '2025-01-01'), ($3, $1, 'E2', 'Bob', 'Two', '2025-01-01') ON CONFLICT DO NOTHING`, [A, EMP[0], EMP[1]]);
}, 60_000);

type Who = 'app_user' | 'postgres' | 'app_user_no_claims' | 'app_user_tenant_b';
async function as(who: Who, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${who === 'postgres' ? 'fz_pg_ns' : 'app_user'}`);
    expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
    if (who === 'app_user' || who === 'app_user_tenant_b') {
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who === 'app_user' ? USER_A : USER_B, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [who === 'app_user' ? A : 'bbbbbbbb-0000-0000-0000-000000000001']);
    }
    await fn(c);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const one = async (q: string, p: unknown[] = []) => (await su.query(q, p)).rows[0];

/** A balanced R1000 payroll journal (draft, then posted, then optionally the legacy 'reversed'), as the superuser. */
async function mkJournal(status: 'posted' | 'reversed', date = '2026-03-31'): Promise<string> {
  const j = (await one(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
    VALUES ($1, 'fz payroll', 'auto_payroll', 'draft', $2, $3) RETURNING id`, [date, USER_A, A])).id as string;
  await su.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES
    ($1, $2, 1000, 0, $5), ($1, $3, 0, 200, $5), ($1, $4, 0, 800, $5)`, [j, ACC.sal, ACC.paye, ACC.bank, A]);
  await su.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [j]);
  if (status === 'reversed') await su.query("UPDATE gl_journal_entries SET status = 'reversed', reversed_at = now() WHERE id = $1", [j]);
  return j;
}
/** An approved run of two lines (R800 net) linked to its posted payroll journal. */
async function finalRun(): Promise<{ run: string; je: string }> {
  month += 1;
  const y = YEAR + Math.floor(month / 12); const m = (month % 12) + 1;
  const je = await mkJournal('posted', `${y}-${String(m).padStart(2, '0')}-28`);
  const run = (await one(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross, total_paye, total_net, employee_count)
    VALUES ($1, $2, $3, 'calculated', make_date($3, $2, 28), 1000, 200, 800, 2) RETURNING id`, [A, m, y])).id as string;
  await su.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, paye, net_pay) VALUES
    ($1, $2, 600, 120, 480), ($1, $3, 400, 80, 320)`, [run, EMP[0], EMP[1]]);
  await su.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = now(), journal_entry_id = $2 WHERE id = $1", [run, je]);
  return { run, je };
}
const journal = async (je: string) => one(`SELECT e.status, count(l.id)::int AS n, COALESCE(sum(l.debit),0)::text AS dr, COALESCE(sum(l.credit),0)::text AS cr
  FROM gl_journal_entries e LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id WHERE e.id = $1 GROUP BY e.status`, [je]);
const ROLES: Who[] = ['app_user', 'postgres'];
const INTACT = { status: 'posted', n: 3, dr: '1000.00', cr: '1000.00' };

describe('FZ breaker (A): a posted payroll journal of a final run cannot be changed', () => {
  for (const who of ROLES) {
    it(`B1 [${who}]: deleting every line of the posted payroll journal is refused`, async () => {
      const { je } = await finalRun();
      await expect(as(who, (c) => c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [je]))).rejects.toThrow(/cannot be added or removed/);
      expect(await journal(je)).toEqual(INTACT);
    });
    it(`B2 [${who}]: rewriting the amounts by DELETE + re-INSERT, kept balanced, is refused`, async () => {
      const { je } = await finalRun();
      await expect(as(who, async (c) => {
        await c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [je]);
        await c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
          VALUES ($1, $2, 1, 0, $4), ($1, $3, 0, 1, $4)`, [je, ACC.sal, ACC.bank, A]);
      })).rejects.toThrow(/cannot be added or removed/);
      expect(await journal(je)).toEqual(INTACT);
    });
    it(`B3 [${who}]: a REVERSED journal takes no one-sided line`, async () => {
      const je = await mkJournal('reversed');
      await expect(as(who, (c) => c.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
        VALUES ($1, $2, 5000, 0, $3)`, [je, ACC.sal, A]))).rejects.toThrow(/cannot be added or removed/);
    });
    it(`B4 [${who}]: posted -> reversed, drop the net-pay credit, reversed -> posted never yields an unbalanced posted journal`, async () => {
      const { je } = await finalRun();
      await expect(as(who, async (c) => {
        await c.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [je]);
        await c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit = 800', [je]);
      })).rejects.toThrow(/cannot be added or removed/);
      expect(await journal(je)).toEqual(INTACT);
    });
    it(`B5 [${who}]: a posted journal is not deleted outright (its lines would cascade)`, async () => {
      const je = await mkJournal('posted');
      await expect(as(who, (c) => c.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]))).rejects.toThrow(/cannot be deleted/);
      expect(await journal(je)).toEqual(INTACT);
    });
  }
  it('B6 [app_user]: the final run\'s posted payroll journal is not re-dated', async () => {
    const { je } = await finalRun();
    await expect(as('app_user', (c) => c.query("UPDATE gl_journal_entries SET entry_date = DATE '2024-01-15' WHERE id = $1", [je]))).rejects.toThrow();
    // trg_gl_je_fiscal_period_from_date refuses a date no period covers first. So, in one rolled-back transaction, the
    // superuser gives company A a 2099 year and June period and a posted payroll journal in it; then fz_pg_ns moves
    // its date inside that period, its company, its created_at: only 999n's rule is left to refuse each.
    const attempt = async (set: string) => {
      const c = await su.connect();
      try {
        await c.query('BEGIN');
        const fy = (await c.query("INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2099, '2099-03-01', '2100-02-28') RETURNING id", [A])).rows[0].id;
        await c.query(`INSERT INTO fiscal_periods (company_id, fiscal_year_id, fiscal_year, period_number, period_name, start_date, end_date)
          VALUES ($1, $2, 2099, 4, 'June 2099', '2099-06-01', '2099-06-30')`, [A, fy]);
        await c.query('SAVEPOINT s');
        const id = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
          VALUES ('2099-06-15', 'fz payroll', 'auto_payroll', 'draft', $1, $2) RETURNING id`, [USER_A, A])).rows[0].id;
        await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 10, 0, $4), ($1, $3, 0, 10, $4)',
          [id, ACC.sal, ACC.bank, A]);
        await c.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [id]);
        await c.query('SET LOCAL ROLE fz_pg_ns');
        await c.query(`UPDATE gl_journal_entries SET ${set} WHERE id = $1`, [id]);
      } finally { await c.query('ROLLBACK'); c.release(); }
    };
    await expect(attempt("entry_date = DATE '2099-06-16'")).rejects.toThrow(/keeps its date and company/);
    await expect(attempt("company_id = (SELECT id FROM companies WHERE id <> company_id LIMIT 1)")).rejects.toThrow(/keeps its date and company/);
    await expect(attempt("created_at = created_at - interval '1 day'")).rejects.toThrow(/created_at is frozen/);
  });
  it('H3: a reversed journal made unbalanced (as the superuser) cannot hop back to posted', async () => {
    const je = await mkJournal('reversed');
    await su.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit = 800', [je]);
    await expect(as('postgres', (c) => c.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]))).rejects.toThrow(/does not balance/);
  });
});

describe('FZ breaker (A): a final run\'s figures cannot be changed', () => {
  it('B7 [app_user]: approved -> cancelled with the stamps kept, edit, -> approved is refused', async () => {
    const { run } = await finalRun();
    await expect(as('app_user', async (c) => {
      await c.query("UPDATE payroll_run_headers SET status = 'cancelled' WHERE id = $1", [run]);
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 5000 WHERE run_id = $1', [run]);
      await c.query('UPDATE payroll_run_headers SET total_net = total_net + 10000 WHERE id = $1', [run]);
      await c.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [run]);
    })).rejects.toThrow(/only with its approval stamps cleared/);
    expect((await one('SELECT total_net::text AS t FROM payroll_run_headers WHERE id = $1', [run])).t).toBe('800.00');
  });
  it('M1: approved -> cancelled with the stamps cleared is still refused while the payroll journal is in force', async () => {
    const { run } = await finalRun();
    await expect(as('postgres', (c) => c.query(
      "UPDATE payroll_run_headers SET status = 'cancelled', approved_at = NULL, approval_grandfathered_at = NULL WHERE id = $1", [run])))
      .rejects.toThrow(/cannot be cancelled/);
  });
  it('B8 [app_user, no claims]: the lines of a final run the caller cannot see are still frozen', async () => {
    const { run } = await finalRun();
    await expect(as('app_user_no_claims', (c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 99999 WHERE run_id = $1', [run])))
      .rejects.toThrow(/figures are frozen/);
  });
  it('B9 [app_user, tenant B]: tenant B cannot delete tenant A\'s final run lines', async () => {
    const { run } = await finalRun();
    await expect(as('app_user_tenant_b', (c) => c.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [run]))).rejects.toThrow(/cannot be deleted/);
    expect((await one('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [run])).n).toBe(2);
  });
  it('H4: a line whose run_id names no header counts as final (fails closed); a header delete still cascades its lines', async () => {
    const { run } = await finalRun();
    expect((await one('SELECT public.payroll_run_is_final(gen_random_uuid()) AS f')).f).toBe(true);
    expect((await one('SELECT public.payroll_run_is_final(gen_random_uuid(), true) AS f')).f).toBe(false);
    // The stated boundary: the owner may delete a whole run header (the reseed wipes this way); the cascade passes.
    await as('postgres', (c) => c.query('DELETE FROM payroll_run_headers WHERE id = $1', [run]));
    expect((await one('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [run])).n).toBe(0);
  });
  it('H4: finality is judged past RLS: a calculated run\'s line, edited by a caller who cannot see its header, is not frozen', async () => {
    // Tenancy on payroll_run_lines is the RLS PR's job; 999n judges only finality, the same for every caller.
    const { run } = await finalRun();
    await su.query("UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1", [run]);
    await as('app_user_no_claims', (c) => c.query('UPDATE payroll_run_lines SET net_pay = net_pay WHERE run_id = $1', [run]));
  });
  it('Demo: the exemption covers the GL DELETE rules only; a posted Demo journal still takes no new line', async () => {
    const DEMO = '00000000-0000-0000-0000-000000000001';
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO companies (id, name) VALUES ($1, 'Demo') ON CONFLICT DO NOTHING", [DEMO]);
      const acct = (await c.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
        VALUES ($1, 'FZ-D1', 'FZ demo', 'expense', 'debit') RETURNING id`, [DEMO])).rows[0].id;
      const je = (await c.query(`INSERT INTO gl_journal_entries (entry_date, description, source, status, created_by, company_id)
        VALUES ('2026-03-31', 'fz demo', 'manual', 'draft', $1, $2) RETURNING id`, [USER_A, DEMO])).rows[0].id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 5, 0, $3), ($1, $2, 0, 5, $3)', [je, acct, DEMO]);
      await c.query("UPDATE gl_journal_entries SET status = 'posted', created_at = now() - interval '1 day' WHERE id = $1", [je]);
      await c.query('SET LOCAL ROLE fz_pg_ns');
      await c.query('SAVEPOINT ins');
      await expect(c.query('INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1, 0, $3)', [je, acct, DEMO]))
        .rejects.toThrow(/cannot be added or removed/);
      await c.query('ROLLBACK TO SAVEPOINT ins');
      await c.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]); // the reseed's wipe: entry and lines go
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  it('B10 [postgres, NOSUPERUSER] (the stated limit): the table owner can still DISABLE the freeze', async () => {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE fz_pg_ns');
      await c.query('ALTER TABLE payroll_run_lines DISABLE TRIGGER trg_payroll_run_lines_final_frozen');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
