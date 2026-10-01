/**
 * BRK-596 round 4 — CLAIM 4 "RECALCULATION IS DETECTED". A real pay change that leaves every
 * credit account and the labour TOTAL unchanged: two employees on two cost centres, each centre
 * mapped to its own labour EXPENSE account, swap salaries. The correct journal moves ~R10 088
 * between two GL expense accounts. The test asserts the claim (the ledger matches the run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let e1: { employee: string; salaryRow: string };
let e2: { employee: string; salaryRow: string };
let acctSales = '';
let acctOps = '';
const [ccSales, ccOps] = [crypto.randomUUID(), crypto.randomUUID()];

beforeAll(async () => {
  r = await rig('c4'); await r.setup();
  e1 = await r.employee(20000); e2 = await r.employee(30000);
  acctSales = await r.account('5210'); acctOps = await r.account('5220');
  for (const [id, code, acct, emp] of [[ccSales, 'SALES', acctSales, e1.employee], [ccOps, 'OPS', acctOps, e2.employee]] as const) {
    await r.pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3)', [id, r.company, code]);
    await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, id, acct]);
    await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [id, emp]);
  }
});
afterAll(async () => { await r.teardown(); });

const labourLines = (lines: Array<{ accountCode: string; debit: number }>) =>
  Object.fromEntries(lines.filter((l) => l.debit > 0).map((l) => [l.accountCode, l.debit]));

describe('CLAIM 4 — recalculation is detected', () => {
  it('C4-A: salaries swapped between two cost centres and recalculated — the run must not re-lock onto the old journal', async () => {
    const id = await r.calculatedRun(1);
    const first = await r.api.approve(id);
    expect(first.statusCode).toBe(200);
    const j1 = String(first.body.data!.journalEntryId);
    const before = { header: await r.header(id), ledger: await r.ledger(1) };
    expect((await r.api.reopen(id)).statusCode).toBe(200);

    await r.setSalary(e1.salaryRow, 30000); // Sales now costs what Ops did, and vice versa
    await r.setSalary(e2.salaryRow, 20000);
    const recalc = await r.api.calculate(id);
    expect(recalc.statusCode).toBe(200);
    const lines = (await r.pool.query(
      `SELECT e.employee_number, l.gross_pay::float8 AS gross, l.paye::float8 AS paye, l.net_pay::float8 AS net
         FROM payroll_run_lines l JOIN payroll_employees e ON e.id = l.employee_id WHERE l.run_id = $1 ORDER BY 1`, [id])).rows;

    const p = await r.api.preview(id);
    const again = await r.api.approve(id);
    const ledger = await r.ledger(1);
    const planNow = p.body.data ? labourLines(p.body.data.plan.lines) : null;
    r.evidence('C4-A salary swap across cost-centre expense accounts', {
      runLinesAfterRecalc: lines, headerBefore: before.header, headerAfter: await r.header(id),
      gate: { blocker: p.body.data?.blocker, relocksOnto: p.body.data?.posted?.journalEntryId, j1 },
      whatTheRunWouldPostToday: planNow, reapprove: [again.statusCode, r.msg(again), again.body.data?.journalEntryId],
      ledgerBefore: before.ledger, ledgerAfter: ledger,
    });
    // The claim: approved ⇒ the ledger carries the run's labour where the run puts it.
    // (origin/master has no plan route: there the run's own lines say where the labour belongs — BRK-1 is Sales/5210.)
    if (again.statusCode === 200) {
      const expected = planNow ?? { 5210: before.ledger['5220'], 5220: before.ledger['5210'] };
      expect({ 5210: ledger['5210'], 5220: ledger['5220'] }).toEqual({ 5210: expected['5210'], 5220: expected['5220'] });
    }
    await r.setSalary(e1.salaryRow, 20000); await r.setSalary(e2.salaryRow, 30000);
  });

  it('C4-B: an employee moved to another cost centre (another EXPENSE account) and recalculated', async () => {
    const id = await r.calculatedRun(2);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    const before = await r.ledger(2);
    await r.api.reopen(id);
    await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [ccSales, e2.employee]); // Ops → Sales
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const p = await r.api.preview(id);
    const again = await r.api.approve(id);
    const ledger = await r.ledger(2);
    const planNow = p.body.data ? labourLines(p.body.data.plan.lines) : null;
    r.evidence('C4-B employee moved between cost-centre expense accounts', {
      gate: { blocker: p.body.data?.blocker, relocksOnto: p.body.data?.posted?.journalEntryId, j1 },
      whatTheRunWouldPostToday: planNow, reapprove: again.statusCode, ledgerBefore: before, ledgerAfter: ledger });
    if (again.statusCode === 200 && planNow) {
      expect({ 5210: ledger['5210'], 5220: ledger['5220'] ?? 0 }).toEqual({ 5210: planNow['5210'], 5220: planNow['5220'] ?? 0 });
    }
    await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [ccOps, e2.employee]);
  });

  it('C4-C (control): a one-cent pay change IS refused', async () => {
    const id = await r.calculatedRun(3);
    await r.api.approve(id);
    await r.api.reopen(id);
    await r.setSalary(e1.salaryRow, 20000.01);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const again = await r.api.approve(id);
    r.evidence('C4-C one cent', { reapprove: [again.statusCode, r.msg(again)] });
    if (r.hasPlanRoute) expect(again.statusCode).toBe(400);
    await r.setSalary(e1.salaryRow, 20000);
  });
});
