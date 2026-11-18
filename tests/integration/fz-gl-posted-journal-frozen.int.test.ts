/**
 * Wave 6 FZ (migration 999n): a posted journal's amounts are frozen, and a journal that arrives posted must balance.
 * Folds in the PR #1524 breaker repros E-1 and E-2 (rev1524-delta2) as refusals. Each forgery runs as app_user under
 * the tenant's RLS and claims, and the key ones again as migration_admin / platform_admin (BYPASSRLS, not superusers). The census's allowed writes on posted
 * lines (account merge and the VAT late-claim split move gl_account_id; tagging moves dimensions) still go through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { rig } from './brkr.helpers';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from '@/modules/accounting/services/payroll/payrollLabourComparison';

let a: Awaited<ReturnType<typeof rig>>;
const FROZEN = /posted journal/;
const UNBALANCED = /does not balance/;
let bankAcct = '';
let expense = '';
let liability = '';

async function asAppUser(fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.admin, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [a.company]);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK').catch(() => undefined); throw err; } finally { c.release(); await pool.end(); }
}
/** One transaction as a non-superuser role that bypasses RLS. */
async function asRole(role: string, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    expect((await c.query("SELECT current_setting('is_superuser') AS su")).rows[0]!.su).toBe('off');
    await fn(c);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK').catch(() => undefined); throw err; } finally { c.release(); await pool.end(); }
}
/**
 * One transaction as migration_admin with session_replication_role = replica, which skips every trigger not ENABLE
 * ALWAYS. The fixture's superuser first grants SET on that parameter (PG15+); all of it rolls back, the grant included.
 * SET CONSTRAINTS ALL IMMEDIATE fires the deferred balance check before the rollback.
 */
async function inReplica(fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('GRANT SET ON PARAMETER session_replication_role TO migration_admin');
    await c.query('SET LOCAL ROLE migration_admin');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    expect((await c.query("SELECT current_setting('is_superuser') AS su")).rows[0]!.su).toBe('off');
    await fn(c);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); await pool.end(); }
}
/** A journal inserted already posted with these [account, debit, credit] lines, in one transaction as app_user. */
const bornPosted = (lines: Array<[string, number, number]>) => asAppUser(async (c) => {
  const je = (await c.query(
    `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
     VALUES ($1, '2026-01-25', 'FZ born posted', 'manual', 'posted', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
  for (const [acct, dr, cr] of lines) {
    await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, $4, $5)',
      [je, a.company, acct, dr, cr]);
  }
});
const postedCount = async () => Number((await a.pool.query(
  "SELECT count(*) FROM gl_journal_entries WHERE company_id = $1 AND description = 'FZ born posted'", [a.company])).rows[0]!.count);

let run = '';
let je = '';

beforeAll(async () => {
  a = await rig('fz-gl');
  await a.setup();
  await a.employee(25000);
  await a.employee(18000);
  const acct = async (code: string) => String((await a.pool.query(
    'SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2', [a.company, code])).rows[0]!.id);
  [bankAcct, expense, liability] = [await acct('1110'), await acct('5200'), await acct('2140')];
  run = await a.calculatedRun(1);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  je = String((await a.header(run)).journal_entry_id);
}, 240_000);
afterAll(async () => { await a.teardown(); });

describe('FZ: a posted journal refuses amount changes', () => {
  it('E-2: app_user cannot edit the real payroll journal\'s net-pay credit and a debit, even kept balanced', async () => {
    const before = (await a.pool.query('SELECT id, debit, credit FROM gl_journal_lines WHERE journal_entry_id = $1 ORDER BY id', [je])).rows;
    await expect(asAppUser(async (c) => {
      await c.query('UPDATE gl_journal_lines SET credit = credit + 50000 WHERE id = (SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND description = ANY($2) AND credit > 0 LIMIT 1)',
        [je, [NET_PAY_DESCRIPTION, NET_PAY_CLEARING_DESCRIPTION]]);
      await c.query('UPDATE gl_journal_lines SET debit = debit + 50000 WHERE id = (SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND debit > 0 LIMIT 1)', [je]);
    })).rejects.toThrow(FROZEN);
    expect((await a.pool.query('SELECT id, debit, credit FROM gl_journal_lines WHERE journal_entry_id = $1 ORDER BY id', [je])).rows).toEqual(before);
  }, 60_000);

  it('a posted line cannot be moved to another journal, and a role that bypasses RLS is refused too', async () => {
    const other = (await a.pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-01-25', 'FZ draft', 'manual', 'draft', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
    await expect(asAppUser((c) => c.query('UPDATE gl_journal_lines SET journal_entry_id = $2 WHERE journal_entry_id = $1', [je, other]))).rejects.toThrow(FROZEN);
    await expect(asRole('migration_admin', (c) => c.query('UPDATE gl_journal_lines SET debit = debit * 10 WHERE journal_entry_id = $1 AND debit > 0', [je]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('a legacy status=\'reversed\' journal is frozen too: no amount edit, no line moved into it', async () => {
    // Today a reversal keeps status 'posted' and stamps reversed_at; older rows were flipped to 'reversed'.
    const legacy = String((await a.pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-01-25', 'FZ legacy reversed', 'manual', 'reversed', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id);
    await a.pool.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,10,0),($1,$2,$4,0,10)',
      [legacy, a.company, expense, bankAcct]);
    await expect(asAppUser((c) => c.query('UPDATE gl_journal_lines SET debit = debit + 1 WHERE journal_entry_id = $1 AND debit > 0', [legacy]))).rejects.toThrow(FROZEN);
    await expect(asAppUser(async (c) => {
      const d = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
         VALUES ($1, '2026-01-25', 'FZ draft 3', 'manual', 'draft', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 5, 0)', [d, a.company, expense]);
      await c.query('UPDATE gl_journal_lines SET journal_entry_id = $1 WHERE journal_entry_id = $2', [legacy, d]);
    })).rejects.toThrow(FROZEN);
  }, 60_000);

  it('a posted journal cannot go back to draft (where its lines are editable again)', async () => {
    await expect(asAppUser((c) => c.query("UPDATE gl_journal_entries SET status = 'draft' WHERE id = $1", [je]))).rejects.toThrow(FROZEN);
  }, 60_000);

  it('E-1: a forged posted payroll journal that does not balance is refused at commit', async () => {
    const n = await postedCount();
    await expect(bornPosted([[expense, 75000, 0], [bankAcct, 0, 25000]])).rejects.toThrow(UNBALANCED);
    expect(await postedCount()).toBe(n);
  }, 60_000);

  it('E-1 as reported (forged journal plus moved net pay and header) is refused by the run freeze', async () => {
    const h = await a.header(run);
    await expect(asAppUser(async (c) => {
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 50000 WHERE run_id = $1', [run]);
      await c.query('UPDATE payroll_run_headers SET total_net = $2 WHERE id = $1', [run, Number(h.net) + 50000]);
    })).rejects.toThrow(/final pay run/);
  }, 60_000);

  it('the once-per-journal check is re-armed: a line written after a passed check is checked again', async () => {
    const n = await postedCount();
    await expect(asAppUser(async (c) => {
      const je = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
         VALUES ($1, '2026-01-25', 'FZ born posted', 'manual', 'posted', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,10,0),($1,$2,$4,0,10)',
        [je, a.company, expense, bankAcct]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // balanced: passes, and takes the journal off the unchecked list
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 7, 0)', [je, a.company, expense]);
    })).rejects.toThrow(UNBALANCED);
    expect(await postedCount()).toBe(n);
  }, 60_000);

  it('a line DELETE re-arms the check too, and a journal born reversed is checked as a posted one is', async () => {
    const born = async (c: PoolClient, status: string) => (await c.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
       VALUES ($1, '2026-01-25', 'FZ born posted', 'manual', $3, $2) RETURNING id`, [a.company, a.admin, status])).rows[0]!.id;
    await expect(asAppUser(async (c) => {
      const je = await born(c, 'posted');
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,10,0),($1,$2,$4,0,10)',
        [je, a.company, expense, bankAcct]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0', [je]);
    })).rejects.toThrow(UNBALANCED);
    await expect(asAppUser(async (c) => {
      const je = await born(c, 'reversed');
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 10, 0)', [je, a.company, expense]);
    })).rejects.toThrow(UNBALANCED);
  }, 60_000);

  it('a posted journal takes no added or removed line, balanced or not; a journal born posted in this transaction must balance', async () => {
    const SET_FROZEN = /cannot be added or removed/;
    await expect(asAppUser((c) => c.query(
      'INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 100, 0), ($1, $2, $4, 0, 100)',
      [je, a.company, expense, bankAcct]))).rejects.toThrow(SET_FROZEN);
    await expect(asAppUser((c) => c.query('DELETE FROM gl_journal_lines WHERE id = (SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND debit > 0 LIMIT 1)', [je])))
      .rejects.toThrow(SET_FROZEN);
    await expect(asRole('platform_admin', (c) => c.query(
      'INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 100, 0)', [je, a.company, expense])))
      .rejects.toThrow(SET_FROZEN);
    // Born posted here: lines may come and go until COMMIT, and the deferred check judges the result.
    await expect(bornPosted([[expense, 100, 0], [bankAcct, 0, 100], [expense, 5, 0]])).rejects.toThrow(UNBALANCED);
  }, 60_000);
  it('session_replication_role = replica skips none of the GL triggers (all ENABLE ALWAYS)', async () => {
    await expect(inReplica((c) => c.query('UPDATE gl_journal_lines SET debit = debit + 1 WHERE journal_entry_id = $1 AND debit > 0', [je])))
      .rejects.toThrow(FROZEN);
    await expect(inReplica((c) => c.query("UPDATE gl_journal_entries SET status = 'draft' WHERE id = $1", [je]))).rejects.toThrow(FROZEN);
    await expect(inReplica((c) => c.query(
      'INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 100, 0)', [je, a.company, expense])))
      .rejects.toThrow(/cannot be added or removed/);
    await expect(inReplica((c) => c.query('DELETE FROM gl_journal_entries WHERE id = $1', [je]))).rejects.toThrow(/cannot be deleted/);
    await expect(inReplica(async (c) => {
      const d = (await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
        VALUES ($1, '2026-01-25', 'FZ draft null', 'manual', 'draft', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
      await c.query('UPDATE gl_journal_entries SET status = NULL WHERE id = $1', [d]);
    })).rejects.toThrow(/status cannot be NULL/);
    await expect(inReplica(async (c) => {
      const born = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
         VALUES ($1, '2026-01-25', 'FZ born posted', 'manual', 'posted', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 100, 0)', [born, a.company, expense]);
    })).rejects.toThrow(UNBALANCED);
  }, 60_000);
});

describe('FZ: what the app writes on posted journals still goes through', () => {
  it('a journal born posted that balances (depreciation, year-end close) commits', async () => {
    const n = await postedCount();
    await bornPosted([[expense, 100, 0], [liability, 0, 60], [bankAcct, 0, 40]]);
    expect(await postedCount()).toBe(n + 1);
  }, 60_000);

  it('the census\'s posted-line writes: account (merge, late claim), dimensions (tagging), late_claim_base', async () => {
    const line = String((await a.pool.query('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND debit > 0 LIMIT 1', [je])).rows[0]!.id);
    await asAppUser(async (c) => {
      await c.query('UPDATE gl_journal_lines SET gl_account_id = $2 WHERE id = $1', [line, liability]);
      await c.query('UPDATE gl_journal_lines SET gl_account_id = $2, cc1_id = NULL, late_claim_base = NULL WHERE id = $1', [line, expense]);
    });
  }, 60_000);

  it('a draft journal\'s lines stay freely editable, and posting it runs the existing balance check', async () => {
    await asAppUser(async (c) => {
      const d = (await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
         VALUES ($1, '2026-01-25', 'FZ draft 2', 'manual', 'draft', $2) RETURNING id`, [a.company, a.admin])).rows[0]!.id;
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,10,0),($1,$2,$4,0,10)', [d, a.company, expense, bankAcct]);
      await c.query('UPDATE gl_journal_lines SET debit = debit * 3 WHERE journal_entry_id = $1 AND debit > 0', [d]);
      await c.query('UPDATE gl_journal_lines SET credit = credit * 3 WHERE journal_entry_id = $1 AND credit > 0', [d]);
      await c.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [d]);
    });
  }, 60_000);
});
