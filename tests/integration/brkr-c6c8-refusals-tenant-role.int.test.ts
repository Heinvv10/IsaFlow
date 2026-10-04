/**
 * BRK-596 round 4 — CLAIM 6 "4XX COMMITS NOTHING" and CLAIM 8 "TENANT AND ROLE".
 * Every refusal is taken through the real route and the company's payroll + ledger + loan rows
 * are fingerprinted before and after. Asserts the claims; red = break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import reopenRoute from '../../pages/api/payroll/runs/[id]/reopen';
import { rig, type Res, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let emp = '';
let salaryRow = '';
const other = crypto.randomUUID();
let viewer = '';
let both = '';
let otherRun = '';
let otherJournal = '';

const fingerprint = async (company: string) => (await r.pool.query(
  `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
     SELECT row_to_json(h)::text AS x FROM payroll_run_headers h WHERE company_id = $1
     UNION ALL SELECT row_to_json(l)::text FROM payroll_run_lines l WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)
     UNION ALL SELECT row_to_json(e)::text FROM gl_journal_entries e WHERE company_id = $1
     UNION ALL SELECT row_to_json(l)::text FROM gl_journal_lines l WHERE company_id = $1
     UNION ALL SELECT row_to_json(b)::text FROM gl_account_balances b WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)
     UNION ALL SELECT row_to_json(p)::text FROM payroll_loans p WHERE company_id = $1
     UNION ALL SELECT row_to_json(s)::text FROM payroll_loan_schedule s WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = $1)
     UNION ALL SELECT row_to_json(p)::text FROM payroll_loan_payments p WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = $1)) s`, [company])).rows[0]!.h as string;

const out: unknown[] = [];
async function refused(name: string, fn: () => Promise<Res>, expectStatus: number[], companies = [r.company]) {
  const before = await Promise.all(companies.map(fingerprint));
  const x = await fn();
  const after = await Promise.all(companies.map(fingerprint));
  const unchanged = before.every((b, i) => b === after[i]);
  out.push({ name, status: x.statusCode, message: r.msg(x)?.slice(0, 110), nothingWritten: unchanged });
  expect.soft(expectStatus, name).toContain(x.statusCode);
  expect.soft(unchanged, `${name}: nothing written`).toBe(true);
}

beforeAll(async () => {
  r = await rig('c6c8'); await r.setup();
  ({ employee: emp, salaryRow } = await r.employee(20000));
  // a second tenant with its own approved run
  await r.pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'BRK596 other tenant']);
  for (const code of ['5200', '2140', '2150', '2160', '1110']) await r.account(code, other);
  await r.employee(15000, other);
  await r.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [other, r.admin]);
  const made = await r.api.createRun(1, { company: other });
  otherRun = String(made.body.data!.id);
  await r.api.calculate(otherRun, { company: other });
  otherJournal = String((await r.api.approve(otherRun, { company: other })).body.data!.journalEntryId);
  viewer = await r.addUser('viewer');
  both = r.admin; // admin of BOTH companies; `company` is the active one unless stated
});
afterAll(async () => { await r.teardown([other]); });

describe('CLAIM 6 — a 4xx commits nothing', () => {
  it('C6: every refusal of approve, reopen and calculate leaves payroll, ledger and loans byte-identical', async () => {
    const loan = crypto.randomUUID();
    await r.pool.query(
      `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
         annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
         first_deduction_period_month,status,outstanding_balance)
       VALUES($1,$2,$3,'BRK-LOAN-6','Staff loan',12000,0.085,12,'straight_line',DATE '2026-05-01',2026,5,'active',10000)`,
      [loan, r.company, emp]);
    await r.pool.query(
      `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
         opening_balance,interest,principal,installment,closing_balance,paid_flag)
       VALUES($1,1,2026,5,10000,0,1000,1000,9000,false)`, [loan]);

    const id = await r.calculatedRun(1);
    const hash = (await r.api.preview(id)).body.data!.planHash;
    await refused('approve: no hash', () => r.api.approveWith(id, undefined), [400]);
    await refused('approve: wrong hash', () => r.api.approveWith(id, 'f'.repeat(64)), [409]);
    await refused('approve: hash as array', () => r.api.approveWith(id, [hash]), [400]);
    await r.pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND account_code = '2150'`, [r.company]);
    await refused('approve: deactivated target account', async () => r.api.approveWith(id, (await r.api.preview(id)).body.data!.planHash), [400]);
    await r.pool.query(`UPDATE gl_accounts SET is_active = true WHERE company_id = $1 AND account_code = '2150'`, [r.company]);
    await r.pool.query(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
                        VALUES ($1, 'Jan 2026', 1, 2026, '2026-01-01', '2026-01-31', 'closed')`, [r.company]).catch(async (e) => { out.push({ fiscalSeed: (e as Error).message }); });
    await refused('approve: closed fiscal period', async () => r.api.approveWith(id, (await r.api.preview(id)).body.data!.planHash), [400]);
    await r.pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [r.company]);
    await refused('reopen: run not approved', () => r.api.reopen(id), [400]);
    await refused('reopen: short reason', () => r.call(reopenRoute as Route, 'POST', `/api/payroll/runs/${id}/reopen`, id, { body: { reason: 'x' } }), [400]);

    const ok = await r.api.approveWith(id, hash);
    expect(ok.statusCode).toBe(200);
    const j1 = String(ok.body.data!.journalEntryId);
    await refused('approve: already approved', () => r.api.approveWith(id, hash), [400]);
    await refused('calculate: approved run', () => r.api.calculate(id), [400]);

    // reopened, journal live, then recalculated to other figures
    await r.api.reopen(id);
    await r.setSalary(salaryRow, 21000);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    await refused('approve: recalculated after posting', () => r.api.approve(id), [400]);
    // reversed and re-reversed
    await r.api.reverse(j1);
    const stale = (await r.api.preview(id)).body.data!.planHash; // a REPLACE hash
    // Round 5: the reversal of a pay run's journal can no longer be reversed (it re-booked the old
    // amounts beside the replacement), so the repro's next step is itself a refusal that writes nothing.
    const contra = await r.contraOf(j1);
    await refused('reverse: the reversal of a pay-run journal', () => r.api.reverse(contra), [400]);
    expect(stale).toBe((await r.api.preview(id)).body.data!.planHash);
    await r.setSalary(salaryRow, 20000);

    // a loan run with its journal live: calculate is refused after the loan lock was taken
    const may = await r.calculatedRun(5);
    expect((await r.api.approve(may)).statusCode).toBe(200);
    await r.api.reopen(may);
    await refused('calculate: loan work under a posted journal', () => r.api.calculate(may), [400]);
    // a calculate that times out on the LOAN lock (after it has the header lock)
    const june = (await r.api.createRun(6)).body.data!.id as string;
    await r.pool.query(
      `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
         opening_balance,interest,principal,installment,closing_balance,paid_flag)
       VALUES($1,2,2026,6,9000,0,1000,1000,8000,false)`, [loan]);
    const holder = await r.pool.connect();
    await holder.query('BEGIN'); await holder.query('SELECT 1 FROM payroll_loans WHERE id = $1 FOR UPDATE', [loan]);
    await refused('calculate: loan row lock timeout', () => r.api.calculate(june), [503]);
    await holder.query('ROLLBACK'); holder.release();
    // and the request after a timeout is healthy
    expect((await r.api.calculate(june)).statusCode).toBe(200);
    r.evidence('C6 refusals', out.splice(0));
  }, 60000);
});

describe('CLAIM 8 — tenant and role', () => {
  it('C8: no cross-tenant read/link/post and no write by a viewer, through every changed path', async () => {
    const id = await r.calculatedRun(8);
    const hash = (await r.api.preview(id)).body.data!.planHash;
    const two = [r.company, other];
    // a member of BOTH companies, active company = `company`, aiming at the OTHER company's run and journal
    await refused('x-tenant: preview other run', () => r.api.preview(otherRun), [404], two);
    await refused('x-tenant: approve other run', () => r.api.approveWith(otherRun, hash), [400, 404], two);
    await refused('x-tenant: reopen other run', () => r.api.reopen(otherRun), [400, 404], two);
    await refused('x-tenant: calculate other run', () => r.api.calculate(otherRun), [400, 404, 500], two);
    await refused('x-tenant: reverse other journal', () => r.api.reverse(otherJournal), [400, 404], two);
    // a row forged by a superuser linking this run to the OTHER company's journal is not read, re-locked or unlinked
    await r.pool.query('UPDATE payroll_run_headers SET journal_entry_id = $1 WHERE id = $2', [otherJournal, id]).catch((e) => out.push({ forgeLink: (e as Error).message }));
    const forged = (await r.header(id)).journal_entry_id === otherJournal;
    if (forged) {
      const p = await r.api.preview(id);
      out.push({ forgedLinkPreview: { blocker: p.body.data?.blocker?.code, posted: p.body.data?.posted, replaces: p.body.data?.replaces } });
      expect.soft(p.body.data?.posted ?? null).toBeNull();
      await refused('x-tenant: approve onto a foreign journal link', () => r.api.approveWith(id, p.body.data?.planHash), [400], two);
      await r.pool.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [id]);
    }
    // viewer
    const v = { user: viewer };
    await refused('viewer: preview', () => r.call(journalPlan as Route, 'GET', `/api/payroll/runs/${id}/journal-plan`, id, v), [403]);
    await refused('viewer: approve', () => r.api.approveWith(id, hash, v), [403]);
    await refused('viewer: calculate', () => r.api.calculate(id, v), [403]);
    // 'viewer: create run' is its own test below.
    expect((await r.api.approveWith(id, hash)).statusCode).toBe(200);
    await refused('viewer: reopen', () => r.api.reopen(id, v), [403]);
    await refused('viewer: reverse payroll journal', async () => r.api.reverse(String((await r.header(id)).journal_entry_id), v), [403]);
    // a stranger (no membership) with the company cookie
    const stranger = await r.addUser('admin', other);
    await r.pool.query('DELETE FROM company_users WHERE user_id = $1', [stranger]);
    await refused('non-member: approve', () => r.api.approveWith(id, hash, { user: stranger }), [401, 403, 404]);
    await refused('non-member: reopen', () => r.api.reopen(id, { user: stranger }), [401, 403, 404]);
    r.evidence('C8 tenant and role', out.splice(0));
    expect(both).toBe(r.admin);
  }, 60000);

  // Closed by D3 (POST /api/payroll/runs is withWriteAccess): this was an `it.fails` pinning the gap.
  it('a viewer cannot create a pay run, and no header is written', async () => {
    const count = async () => Number((await r.pool.query('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [r.company])).rows[0].n);
    const before = await count();
    const made = await r.api.createRun(9, { user: viewer });
    expect(made.statusCode).toBe(403);
    expect(await count()).toBe(before);
  });
});
