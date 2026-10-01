/**
 * BRK-596 — CLAIM 3 "NEVER STUCK". Each test asserts the claim; a red test is the break.
 *
 * Ported in W3-01 round 5. C3-A's repro reached its dead end by reversing the REVERSAL of the run's
 * journal ("the user un-reverses"). Round 5 closes that door — the generic reversal refuses it — and
 * makes the gate judge by what the reversal chain leaves in the ledger, so the state the repro built
 * is also no longer a dead end for books that already hold it. Both are asserted here; the legacy
 * state is staged with the new guard switched off, which is how it was reached before the guard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ off: false }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalReversalGuard', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollJournalReversalGuard')>();
  return {
    ...actual,
    refuseReversalAgainstPayRun: async (...a: Parameters<typeof actual.refuseReversalAgainstPayRun>) => {
      if (!guard.off) await actual.refuseReversalAgainstPayRun(...a);
    },
  };
});

import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let salaryRow = '';
let emp = '';
beforeAll(async () => { r = await rig('c3'); await r.setup(); ({ salaryRow, employee: emp } = await r.employee(20000)); });
afterAll(async () => { await r.teardown(); });

describe('CLAIM 3 — never stuck', () => {
  it('C3-A: the reversal of a run\'s journal cannot be reversed, and the month is approved by re-approving', async () => {
    const id = await r.calculatedRun(1);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.reverse(j1)).statusCode).toBe(200);
    const contra = await r.contraOf(j1);
    const undo = await r.api.reverse(contra); // "un-reverse": what led to the dead end
    expect(undo.statusCode).toBe(400);
    expect(r.msg(undo)).toMatch(/approve the pay run/);

    await r.setSalary(salaryRow, 30000);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const a = await r.api.approve(id);
    r.evidence('C3-A un-reverse refused, then approved', { undo: [undo.statusCode, r.msg(undo)], approve: a.statusCode, header: await r.header(id), ledger: await r.ledger(1) });
    expect(a.statusCode).toBe(200);
    expect(await r.header(id)).toMatchObject({ status: 'approved', gross: 30000 });
    expect((await r.ledger(1))['5200']).toBe((await r.api.preview(id)).body.data!.plan.totalDebit);
    await r.setSalary(salaryRow, 20000);
  });

  it('C3-A (books that already hold it): journal, reversal, reversal-of-the-reversal — every step has an exit', async () => {
    const id = await r.calculatedRun(2);
    const j1 = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.reverse(j1)).statusCode).toBe(200);
    const contra = await r.contraOf(j1);
    guard.off = true; // as it was before round 5
    try { expect((await r.api.reverse(contra)).statusCode).toBe(200); } finally { guard.off = false; }
    const rebooked = await r.contraOf(contra);
    const once = (await r.ledger(2))['5200'];

    // The old amounts are in the ledger again, and the gate says so: the run re-locks onto them.
    const p1 = (await r.api.preview(id)).body.data!;
    expect(p1.blocker).toBeNull();
    expect(p1.posted).toMatchObject({ journalEntryId: j1 });

    // The pay is corrected, as the reopen intended.
    await r.setSalary(salaryRow, 30000);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const p2 = (await r.api.preview(id)).body.data!;
    const number = (jid: string) => r.pool.query('SELECT entry_number FROM gl_journal_entries WHERE id = $1', [jid]).then((x) => String(x.rows[0]!.entry_number));
    expect(p2.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    expect(p2.blocker.detail).toContain(`Reverse journal ${await number(rebooked)} first`); // the one actually in force
    expect((await r.api.approve(id)).statusCode).toBe(400);

    // Doing what it says takes the month out of the ledger…
    expect((await r.api.reverse(rebooked)).statusCode).toBe(200);
    expect((await r.ledger(2))['5200']).toBe(0);
    // …and the run is then approved onto a fresh journal. The breaker's dead end said "its amounts
    // are back in the ledger" here, with nothing in the ledger.
    const p3 = (await r.api.preview(id)).body.data!;
    expect(p3.blocker).toBeNull();
    expect(p3.replaces).toMatchObject({ journalEntryId: j1 });
    const a = await r.api.approve(id);
    r.evidence('C3-A legacy chain of four', { approve: a.statusCode, header: await r.header(id), ledger: await r.ledger(2), journals: await r.journals('02') });
    expect(a.statusCode).toBe(200);
    expect(await r.header(id)).toMatchObject({ status: 'approved', gross: 30000 });
    // The month once, at the new pay — the old amounts are not there beside it.
    expect(p3.plan.totalDebit).toBeGreaterThan(once);
    expect((await r.ledger(2))['5200']).toBe(p3.plan.totalDebit);
    await r.setSalary(salaryRow, 20000);
  });

  it('C3-B: a reopened run with a staff-loan instalment is recalculated once its journal is reversed', async () => {
    const loan = crypto.randomUUID();
    await r.pool.query(
      `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
         annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
         first_deduction_period_month,status,outstanding_balance)
       VALUES($1,$2,$3,'BRK-LOAN-1','Staff loan',12000,0.085,12,'straight_line',DATE '2026-03-01',2026,3,'active',10000)`,
      [loan, r.company, emp]);
    await r.pool.query(
      `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
         opening_balance,interest,principal,installment,closing_balance,paid_flag)
       VALUES($1,1,2026,3,10000,0,1000,1000,9000,false)`, [loan]);
    await r.setSalary(salaryRow, 20000);
    const id = await r.calculatedRun(3);
    const a = await r.api.approve(id);
    expect(a.statusCode).toBe(200);
    const j1 = String(a.body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    await r.setSalary(salaryRow, 25000); // the correction the run was reopened for

    // Journal in force: refused, with the instruction.
    const c1 = await r.api.calculate(id);
    expect(c1.statusCode).toBe(400);
    expect(r.msg(c1)).toMatch(/Reverse the payroll journal first/);
    // Do exactly what it says…
    expect((await r.api.reverse(j1)).statusCode).toBe(200);
    // …and the calculation goes through, at the corrected pay, with the instalment taken once.
    const c2 = await r.api.calculate(id);
    expect(c2.statusCode).toBe(200);
    expect(c2.body.data).toMatchObject({ totalGross: 25000 });
    const loanNow = (await r.pool.query('SELECT outstanding_balance::float8 AS o FROM payroll_loans WHERE id = $1', [loan])).rows[0]!.o;
    const payments = (await r.pool.query('SELECT count(*)::int AS n FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows[0]!.n;
    expect({ loanNow, payments }).toEqual({ loanNow: 9000, payments: 1 });
    // The run is then approved onto a fresh journal carrying the corrected pay.
    const a2 = await r.api.approve(id);
    r.evidence('C3-B loan run recalculated after its journal was reversed', { calculate: [c1.statusCode, c2.statusCode], approve: a2.statusCode, header: await r.header(id) });
    expect(a2.statusCode).toBe(200);
    expect(a2.body.data!.journalEntryId).not.toBe(j1);
    expect(await r.header(id)).toMatchObject({ status: 'approved', gross: 25000 });
    // And with the fresh journal in force the guard is back.
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect((await r.api.calculate(id)).statusCode).toBe(400);
  });
});
