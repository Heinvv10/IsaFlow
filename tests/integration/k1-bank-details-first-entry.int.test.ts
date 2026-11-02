/**
 * Wave 3 K1, Hein's ruling on D1 (2026-11-02): a manager may make the first bank details entry only for an employee who
 * has never been in an approved run (approved, posted or paid, in any period, approved and later reopened too);
 * otherwise only owner or admin may (403 FIRST_ENTRY_REQUIRES_ADMIN, written before anything is). Through the real route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { reasonOf } from './r035-approval.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, put, ROW, rowsOf } from './k1-employee-bank-details.helpers';
import { als } from '../../src/lib/als';
import { parseBankDetailsInput, setEmployeeBankDetails } from '../../src/modules/accounting/services/payroll/payrollBankDetailsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '';

beforeAll(async () => { [o, a, m] = await members(pool, tokens, 3); });
afterAll(async () => {
  // Run lines RESTRICT an employee's delete: the runs go first.
  await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1::uuid[])', [companies]);
  await pool.query("DELETE FROM gl_journal_entries WHERE company_id = ANY($1::uuid[])", [companies]);
  await cleanupEntityChanges(pool, companies, [o, a, m]);
});

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager']], companies);

interface RunShape {
  status: string; month?: number; year?: number; approvedAt?: boolean; history?: boolean; journal?: boolean;
  taxed?: boolean; line?: boolean; reopened?: boolean;
  /** approved_taxed_employees written as NULL (unknown), not left out: only with `history` or `reopened`. */
  taxedUnknown?: boolean;
  /** The employee's start date, moved after the run's period once the run was approved. */
  startedAfter?: boolean;
  /** The employee's start date, set after the run is written. */
  started?: string;
}

/** A run of `company` holding `emp`, in the shape given, written as the table owner. */
async function run(c: string, emp: string, shape: RunShape): Promise<void> {
  const journal = shape.journal ? (await pool.query<{ id: string }>(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
     VALUES ($1, $2, DATE '2026-01-31', 'K1 payroll', 'posted', 'auto_payroll', $3) RETURNING id`,
    [c, `K1-${crypto.randomUUID().slice(0, 8)}`, o])).rows[0]!.id : null;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, approved_at, approval_history,
       journal_entry_id, approved_taxed_employees, reopened_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END,
       CASE WHEN $6 THEN tstzmultirange(tstzrange(now() - interval '1 day', now(), '[)')) END, $7,
       CASE WHEN $8 THEN ARRAY[$9::uuid] WHEN $11 THEN NULL WHEN $6 OR $10 THEN '{}'::uuid[] END,
       CASE WHEN $10 THEN now() END)
     RETURNING id`,
    [c, shape.month ?? 1, shape.year ?? 2026, shape.status, shape.approvedAt === true, shape.history === true, journal,
      shape.taxed === true, emp, shape.reopened === true, shape.taxedUnknown === true]);
  const started = shape.startedAfter ? '2027-01-01' : shape.started;
  if (started) await pool.query('UPDATE payroll_employees SET start_date = $2::date WHERE id = $1', [emp, started]);
  if (shape.line !== false) await pool.query('INSERT INTO payroll_run_lines (run_id, employee_id) VALUES ($1, $2)', [rows[0]!.id, emp]);
}

async function inRun(shape: RunShape): Promise<{ c: string; e: string }> {
  const c = await company();
  const e = await employee(pool, c);
  await run(c, e, shape);
  return { c, e };
}

describe('a manager\'s first entry for an employee already paid through a run', () => {
  it.each<[string, RunShape]>([
    ['an approved run', { status: 'approved', approvedAt: true }],
    ['a paid run', { status: 'paid', approvedAt: true }],
    ['an approved run from before 718 stamped approved_at', { status: 'approved' }],
    ['a paid run from before 718', { status: 'paid' }],
    ['a posted run, its journal linked, whatever its status', { status: 'calculated', journal: true }],
    // The app clears approved_at only with a reopen; a run moved off 'approved' by an older path or by hand keeps it.
    ['a run cancelled by hand while approved, approved_at kept', { status: 'cancelled', approvedAt: true }],
    ['a run approved, then reopened', { status: 'calculated', history: true }],
    ['a run reopened, its history lost, reopened_at kept', { status: 'calculated', reopened: true }],
    ['a run approved, reopened, and the employee since taken off it', { status: 'calculated', history: true, line: false }],
    ['the same, paid with nothing taxable, so not in the taxed set', { status: 'calculated', reopened: true, line: false }],
    ['the same, the employee having started within that run\'s month', { status: 'calculated', history: true, line: false, started: '2026-01-31' }],
    ['the same, the run\'s taxed set unknown (NULL)', { status: 'calculated', history: true, taxedUnknown: true, line: false }],
    ['taken off a reopened run, taxed by it, start date since moved past it', { status: 'calculated', history: true, taxed: true, line: false, startedAfter: true }],
    ['a run approved, reopened and cancelled', { status: 'cancelled', history: true }],
    ['an approved run of an earlier year', { status: 'paid', approvedAt: true, month: 2, year: 2021 }],
  ])('%s: 403 FIRST_ENTRY_REQUIRES_ADMIN, and nothing is written', async (_name, shape) => {
    const { c, e } = await inRun(shape);
    const res = await put(tokens[m]!, c, e, ROW);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
    expect(reasonOf(res)).toBe('FIRST_ENTRY_REQUIRES_ADMIN');
    expect((res.state.body as { error?: { message?: string } }).error?.message)
      .toBe('Only an owner or admin can enter bank details for an employee who has been paid through an approved run.');
    expect(await rowsOf(pool, e)).toEqual([]);
    const { rows } = await pool.query("SELECT 1 FROM entity_changes WHERE entity_type = 'payroll_bank_detail' AND company_id = $1", [c]);
    expect(rows).toEqual([]);
  });

  it.each([['an owner', () => o], ['an admin', () => a]])('%s may still make it', async (_name, user) => {
    const { c, e } = await inRun({ status: 'paid', approvedAt: true });
    expect((await put(tokens[user()]!, c, e, ROW)).state.statusCode).toBe(200);
    expect(await rowsOf(pool, e)).toHaveLength(1);
  });

  it('a change by a manager is still CHANGE_REQUIRES_ADMIN, the rule it always met', async () => {
    const { c, e } = await inRun({ status: 'paid', approvedAt: true });
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const res = await put(tokens[m]!, c, e, { ...ROW, bankName: 'Other' });
    expect([res.state.statusCode, reasonOf(res)]).toEqual([403, 'CHANGE_REQUIRES_ADMIN']);
  });
});

describe('a manager\'s first entry that stays open', () => {
  it.each<[string, RunShape | null]>([
    ['no run at all', null],
    ['a draft run', { status: 'draft' }],
    ['a calculated run, never approved', { status: 'calculated' }],
    ['a run cancelled before approval', { status: 'cancelled' }],
    ['a reopened run of a period before the employee started', { status: 'calculated', history: true, reopened: true, line: false, startedAfter: true }],
    ['an approved run the employee was never on', { status: 'approved', approvedAt: true, line: false }],
    ['a reopened run of the month before the employee started', { status: 'calculated', history: true, line: false, started: '2026-02-01' }],
  ])('%s: the entry lands', async (_name, shape) => {
    const c = await company();
    const e = await employee(pool, c);
    if (shape) await run(c, e, shape);
    const res = await put(tokens[m]!, c, e, ROW);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const [row] = await rowsOf(pool, e);
    expect((await changesOf(pool, row!.id)).map((x) => [x.op, x.actor])).toEqual([['create', m]]);
  });

  it('another employee\'s approved run does not count', async () => {
    const c = await company();
    const [paid, fresh] = [await employee(pool, c), await employee(pool, c)];
    await run(c, paid, { status: 'paid', approvedAt: true });
    expect((await put(tokens[m]!, c, fresh, ROW)).state.statusCode).toBe(200);
  });

  it('only this company\'s runs count: a run filed under another company is not this employee\'s pay', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const elsewhere = await company();
    await run(elsewhere, e, { status: 'paid', approvedAt: true });
    expect((await put(tokens[m]!, c, e, ROW)).state.statusCode).toBe(200);
  });
});

/** A held transaction: `lock` takes it, `release` ends it. */
async function holder(sqlText: string, params: unknown[] = []) {
  const client = await pool.connect();
  await client.query('BEGIN');
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await client.query(sqlText, params);
  return { pid, client, release: async () => { await client.query('ROLLBACK'); client.release(); } };
}
const APPROVAL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))';
/** Waits until some backend is blocked by `pid`. */
const blockedBy = (pid: number) => vi.waitFor(async () => {
  const { rows } = await pool.query('SELECT 1 FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[$1::int]', [pid]);
  expect(rows).toHaveLength(1);
}, { timeout: 8000, interval: 25 });

describe('a manager\'s first entry racing payroll approval', () => {
  it('waits for the approval and then refuses the now-approved employee', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const approving = await holder(APPROVAL, [`payroll_approval:${c}`]);
    let entering: ReturnType<typeof put> | undefined;
    try {
      entering = put(tokens[m]!, c, e, ROW);
      await blockedBy(approving.pid);
      const runId = (await approving.client.query<{ id: string }>(
        `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, approved_at)
         VALUES ($1, 1, 2026, 'approved', clock_timestamp()) RETURNING id`, [c])).rows[0]!.id;
      await approving.client.query('INSERT INTO payroll_run_lines (run_id, employee_id) VALUES ($1, $2)', [runId, e]);
      await approving.client.query('COMMIT');
      const res = await entering;
      expect([res.state.statusCode, reasonOf(res)]).toEqual([403, 'FIRST_ENTRY_REQUIRES_ADMIN']);
      expect(await rowsOf(pool, e)).toEqual([]);
    } finally {
      await approving.client.query('ROLLBACK').catch(() => undefined);
      approving.client.release();
      await entering?.catch(() => undefined);
    }
  });

  it('an owner\'s PUT does not take the approval lock (the first-entry rule is its only reader)', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const approving = await holder(APPROVAL, [`payroll_approval:${c}`]);
    try {
      expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    } finally { await approving.release(); }
  });

  it('a manager\'s PUT takes it, before the employee row: holding the row, the PUT already holds the approval lock', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const rowHolder = await holder('SELECT 1 FROM payroll_employees WHERE id = $1 FOR UPDATE', [e]);
    let entering: ReturnType<typeof put> | undefined;
    try {
      entering = put(tokens[m]!, c, e, ROW);
      await blockedBy(rowHolder.pid);
      const probe = await pool.query('SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS got', [`payroll_approval:${c}`]);
      expect(probe.rows[0]!.got, 'the PUT waits on the employee row without the approval lock').toBe(false);
      await rowHolder.client.query('COMMIT');
      expect((await entering).state.statusCode).toBe(200);
    } finally {
      await rowHolder.client.query('ROLLBACK').catch(() => undefined);
      rowHolder.client.release();
      await entering?.catch(() => undefined);
    }
  });

  it('the approval-lock wait is a 503 naming payroll for the company', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const approving = await holder(APPROVAL, [`payroll_approval:${c}`]);
    try {
      const res = await put(tokens[m]!, c, e, ROW);
      expect(res.state.statusCode).toBe(503);
      expect(JSON.stringify(res.state.body)).toContain('Payroll for this company is being changed by another request');
      expect(await rowsOf(pool, e)).toEqual([]);
    } finally { await approving.release(); }
  }, 15000);

  it('the two waits share one 5s budget: 3s on the approval lock, then 3s on the row, is a 503 near 5s', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const approving = await holder(APPROVAL, [`payroll_approval:${c}`]);
    const rowHolder = await holder('SELECT 1 FROM payroll_employees WHERE id = $1 FOR UPDATE', [e]);
    const t0 = Date.now();
    const entering = put(tokens[m]!, c, e, ROW);
    try {
      await new Promise((r) => setTimeout(r, 3000));
      await approving.release();
      const res = await entering;
      expect(res.state.statusCode).toBe(503);
      expect(Date.now() - t0).toBeLessThan(5900);
    } finally {
      await rowHolder.release();
      await entering.catch(() => undefined);
    }
  }, 20000);
});

describe('the schema the migrations build', () => {
  // payroll_run_headers.posted_journal_entry_id is in dev's schema (and so the CI baseline) but no migration makes it.
  it('the rule reads no column a migration does not create', async () => {
    const { c, e } = await inRun({ status: 'calculated', journal: true });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE payroll_run_headers DROP COLUMN IF EXISTS posted_journal_entry_id CASCADE');
      const refused = als.run({ client, companyId: c, claims: {}, afterCommit: [] } as never,
        () => setEmployeeBankDetails(c, e, parseBankDetailsInput(ROW), 'manager'));
      await expect(refused).rejects.toMatchObject({ code: 'FIRST_ENTRY_REQUIRES_ADMIN' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
