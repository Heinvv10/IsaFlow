/**
 * Wave 7 OCP (W34, W36; grill F2): the owner cash position reads PAID EVIDENCE: a run marked paid (typed reference or
 * confirmed file), else a confirmed salary bank file, else the labelled payday inference. Real PG, two tenants (B at 10x
 * the amounts), a window of 20 May 2026; every case rolls back.
 *
 * Regular run: gross 20 000, PAYE 2 000, so net 18 000; it is due 31 May (no run_date, so its period end). Statutory
 * owed once its net pay has left is its PAYE: 2 000.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', noRunDate: true, gross: 20000, paye: 2000 };
const REGULAR_10X: RunSpec = { ...REGULAR, gross: 200000, paye: 20000 };
const NOW = new Date('2026-05-20T10:00:00Z');

beforeAll(async () => {
  A = await seedTenant(pool, 'w7 ocp A');
  B = await seedTenant(pool, 'w7 ocp B');
});
afterAll(async () => { try { await dropTenants(pool, [A, B]); } finally { await pool.end(); } });

/** A confirmed salary bank file paying the run's one line, made as the table owner under a session user (999h stamps it). */
async function confirmedFile(c: PoolClient, t: Tenant, runId: string, actionDate: string): Promise<void> {
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: t.user, role: 'authenticated' })]);
  const cents = Number((await c.query('SELECT round(net_pay * 100)::bigint AS c FROM payroll_run_lines WHERE run_id = $1', [runId])).rows[0].c);
  const file = String((await c.query(
    `INSERT INTO payroll_bank_files (company_id, run_id, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
     SELECT company_id, id, 'fnb_obe_2023_02', repeat('e', 64), 1, $2, $3::date, COALESCE(approved_at, approval_grandfathered_at), 'x'
       FROM payroll_run_headers WHERE id = $1 RETURNING id`, [runId, cents, actionDate])).rows[0].id);
  await c.query('INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents) VALUES ($1, $2, $3, $4)', [t.company, file, t.employee, cents]);
  await c.query("UPDATE payroll_bank_files SET status = 'confirmed' WHERE id = $1", [file]);
}

const at = (t: Tenant, cash = 1_000_000) => () => getOwnerCashPosition(t.company, cash, NOW, { payroll: true });

describe('a run marked paid by a typed reference', () => {
  it('its net pay has left before its pay date: only its PAYE is owed, shown as paid, recorded, on its paid_on date', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, { ...REGULAR, status: 'paid', approvedAt: REGULAR.runDate });
      await c.query("UPDATE payroll_run_headers SET paid_on = '2026-05-19', paid_reference = 'FNB EFT 7' WHERE id = $1", [id]);
    }, at(A));
    expect(got.payroll).toMatchObject({ status: 'paid', paidBasis: 'recorded', paidOn: '2026-05-19', totalRequired: 2000, canPay: true });
  });
  it('a legacy paid row with no payment date (the Demo reseed) is still paid; the same run unpaid needs its net pay too', async () => {
    const legacy = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, { ...REGULAR, status: 'paid', approvedAt: REGULAR.runDate }); }, at(A));
    expect(legacy.payroll).toMatchObject({ paidBasis: 'recorded', paidOn: null, totalRequired: 2000 });
    const unpaid = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, REGULAR); }, at(A));
    expect(unpaid.payroll).toMatchObject({ totalRequired: 20000, status: 'approved' });
    expect(unpaid.payroll!.paidBasis).toBeUndefined();
  });
});

describe('a confirmed salary bank file is the evidence when the run is not marked paid', () => {
  it('reopened after payday (L1): the file the bank accepted still says the net pay left', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, REGULAR);
      await confirmedFile(c, A, id, '2026-05-19');
      await c.query("UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1", [id]);
    }, at(A));
    expect(got.payroll).toMatchObject({ status: 'estimated', paidBasis: 'bank_file', paidOn: '2026-05-19', totalRequired: 2000 });
  });
  it('a file whose action date is still ahead has not paid: the full run is owed', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => { await confirmedFile(c, A, await seedRun(c, A, REGULAR), '2026-05-25'); }, at(A));
    expect(got.payroll).toMatchObject({ totalRequired: 20000 });
    expect(got.payroll!.paidBasis).toBeUndefined();
  });
  it('another tenant\'s confirmed file (10x the amounts) changes nothing here, and its own figure is its own', async () => {
    let bPaid = 0;
    const a = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, REGULAR);
      const other = await seedRun(c, B, REGULAR_10X);
      await confirmedFile(c, B, other, '2026-05-19');
      bPaid = Number((await c.query('SELECT count(*)::int AS n FROM payroll_bank_files WHERE run_id = $1', [other])).rows[0].n);
    }, at(A));
    expect(bPaid).toBe(1);
    expect(a.payroll).toMatchObject({ totalRequired: 20000 });
    expect(a.payroll!.paidBasis).toBeUndefined();
    const b = await twoRunsInMonth(pool, B, async (c) => { await confirmedFile(c, B, await seedRun(c, B, REGULAR_10X), '2026-05-19'); }, at(B));
    expect(b.payroll).toMatchObject({ paidBasis: 'bank_file', totalRequired: 20000 });
  });
});

describe('the inference stays, labelled, for a run with neither', () => {
  it('an approved run past its pay date with no file and no mark is inferred, and says so', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, { ...REGULAR, runDate: '2026-05-15', noRunDate: false }); },
      () => getOwnerCashPosition(A.company, 1_000_000, NOW, { payroll: true }));
    expect(got.payroll).toMatchObject({ paidBasis: 'inferred', paidOn: '2026-05-15', totalRequired: 2000 });
  });
  it('two-run month: a paid bonus and the regular run due later; the regular run is the one reported', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, REGULAR);
      const bonus = await seedRun(c, A, { year: 2026, month: 5, runDate: '2026-05-15', offCycle: true, gross: 5000, paye: 700, status: 'paid', approvedAt: '2026-05-15' });
      await c.query("UPDATE payroll_run_headers SET paid_on = '2026-05-15' WHERE id = $1", [bonus]);
    }, at(A));
    expect(got.payroll).toMatchObject({ runsCounted: 2, totalRequired: 20000 + 700 });
    expect(got.payroll!.paidBasis).toBeUndefined();
  });
});

// Review O1/O2 of a4486fab49. The garnishee rows are synthetic (guards and FK checks off for the rolled-back transaction
// only, as w7-gc2-reopen-balance does): the reader alone, over shapes the routes produce.
async function garnishee(c: PoolClient, t: Tenant, runId: string, rands: number, creditorPaidFile?: string): Promise<void> {
  await c.query("SET LOCAL session_replication_role = 'replica'");
  for (const tbl of ['payroll_garnishee_orders', 'payroll_garnishee_deductions', 'payroll_bank_file_items']) await c.query(`ALTER TABLE ${tbl} DISABLE TRIGGER USER`);
  const order = crypto.randomUUID();
  await c.query(
    `INSERT INTO payroll_garnishee_orders (id, company_id, employee_id, kind, reference, creditor_name, instalment, start_date, payable_account_id, created_by)
     VALUES ($1, $2, $3, 'maintenance', 'W7 OCP', 'Court Creditor', $4, '2026-01-01', $5, 'x')`, [order, t.company, t.employee, rands, crypto.randomUUID()]);
  await c.query(
    `INSERT INTO payroll_garnishee_deductions (company_id, run_id, order_id, employee_id, requested, amount, balance_applied)
     VALUES ($1, $2, $3, $4, $5, $5, true)`, [t.company, runId, order, t.employee, rands]);
  if (creditorPaidFile) {
    await c.query(
      `INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents, garnishee_order_id, creditor_bank_name, creditor_branch_code,
         creditor_account_number, creditor_account_type, creditor_bank_set_at) VALUES ($1, $2, $3, $4, $5, 'FNB', '250655', '62001234567', 'cheque', now())`,
      [t.company, creditorPaidFile, t.employee, rands * 100, order]);
  }
}
const confirmedFileId = async (c: PoolClient, runId: string) =>
  String((await c.query("SELECT id FROM payroll_bank_files WHERE run_id = $1 AND status = 'confirmed'", [runId])).rows[0].id);

describe('garnishee creditors are cash the run needs (O1)', () => {
  it('an approved run with R3 000 of garnishees needs 3 000 more, named in garnisheeOwed', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => { await garnishee(c, A, await seedRun(c, A, REGULAR), 3000); }, at(A));
    expect(got.payroll).toMatchObject({ totalRequired: 23000, garnisheeOwed: 3000 });
  });
  it('another tenant\'s garnishees (10x) never reach this company\'s figure', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, REGULAR);
      await garnishee(c, B, await seedRun(c, B, REGULAR_10X), 30000);
    }, at(A));
    expect(got.payroll).toMatchObject({ totalRequired: 20000 });
    expect(got.payroll!.garnisheeOwed).toBeUndefined();
  });
  it('marked paid by a typed reference: the payable is still open, so the garnishee is still owed', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, { ...REGULAR, status: 'paid', approvedAt: REGULAR.runDate });
      await c.query("UPDATE payroll_run_headers SET paid_on = '2026-05-19', paid_reference = 'EFT 1' WHERE id = $1", [id]);
      await garnishee(c, A, id, 3000);
    }, at(A));
    expect(got.payroll).toMatchObject({ paidBasis: 'recorded', totalRequired: 2000 + 3000, garnisheeOwed: 3000 });
  });
  it('a confirmed file with the creditor line has paid it; a file without one leaves it owed', async () => {
    const covered = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, REGULAR);
      await confirmedFile(c, A, id, '2026-05-19');
      await garnishee(c, A, id, 3000, await confirmedFileId(c, id));
    }, at(A));
    expect(covered.payroll).toMatchObject({ paidBasis: 'bank_file', totalRequired: 2000 });
    expect(covered.payroll!.garnisheeOwed).toBeUndefined();
    const notCovered = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, REGULAR);
      await confirmedFile(c, A, id, '2026-05-19');
      await garnishee(c, A, id, 3000);
    }, at(A));
    expect(notCovered.payroll).toMatchObject({ paidBasis: 'bank_file', totalRequired: 2000 + 3000, garnisheeOwed: 3000 });
  });
});

describe('a confirmed file of an earlier approval, the run approved again higher (O2)', () => {
  it('what the file left unpaid to the employee is owed, not nothing', async () => {
    const got = await twoRunsInMonth(pool, A, async (c) => {
      const id = await seedRun(c, A, REGULAR);
      await confirmedFile(c, A, id, '2026-05-19');
      await c.query('UPDATE payroll_run_lines SET net_pay = net_pay + 500 WHERE run_id = $1', [id]);
    }, at(A));
    expect(got.payroll).toMatchObject({ paidBasis: 'bank_file', totalRequired: 2000 + 500 });
  });
});
