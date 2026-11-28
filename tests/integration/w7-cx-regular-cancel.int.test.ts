/**
 * Wave 7 CX (W28): cancelling a calculated regular run that was never approved, through the real route (withAuth,
 * app_user, RLS), on two tenants (B at 10x the amounts, in a later month).
 * Claims:
 *  - a calculated run with a loan instalment, a garnishee deduction and a pending approval request is cancelled: the loan
 *    balance, schedule row and totals are restored EXACTLY (tombstone kept), the deduction is dropped with the order
 *    balance unchanged, the request is withdrawn, the lines and the header are gone, and one audit_log row keeps the
 *    period, frequency, line count, totals and the released ids;
 *  - a new run for the period is then created and calculated, taking the instalment again;
 *  - refused (409, NOTHING changed): a draft, an approved run, a run approved then reopened and recalculated with its
 *    journal reversed, a run whose approval request was approved, a run with a later calculated run of its frequency,
 *    and a run whose only evidence is an audit row, an EMP201 return or a frozen payslip (999o refuses a delivery
 *    for a run that is not final); 403 for a manager; 404 for
 *    the other tenant.
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Res, type Route } from './brkr.helpers';
import cancel from '../../pages/api/payroll/runs/[id]/cancel';
import approvalRequests from '../../pages/api/accounting/approval-requests';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

type Rig = Awaited<ReturnType<typeof rig>>;
let a: Rig;
let b: Rig;
const t = { emp: '', loan: '', order: '' };
const tb = { emp: '', loan: '', order: '' };

const ok = (x: Res, code = 200) => expect(x.statusCode, JSON.stringify(x.body)).toBe(code);
const cancelRun = (r: Rig, id: string, o: { user?: string } = {}) => r.call(cancel as Route, 'POST', `/api/payroll/runs/${id}/cancel`, id, o);
const one = async (r: Rig, q: string, params: unknown[]) => (await r.pool.query(q, params)).rows[0];

async function loan(r: Rig, employee: string, month: number, instalment: number, balance: number): Promise<string> {
  const id = crypto.randomUUID();
  await r.pool.query(`INSERT INTO payroll_components(company_id,name,sars_source_code,component_type,is_taxable)
    VALUES($1,'Staff loan repayment','LOAN','deduction',false)`, [r.company]);
  await r.pool.query(`INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
      annual_interest_rate,term_months,method,start_date,first_deduction_period_year,first_deduction_period_month,status,outstanding_balance)
    VALUES($1,$2,$3,'CX-LOAN','Staff loan',$4,0.085,12,'straight_line',make_date(2026,$5,1),2026,$5,'active',$4)`,
  [id, r.company, employee, balance, month]);
  await r.pool.query(`INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
      opening_balance,interest,principal,installment,closing_balance,paid_flag)
    VALUES($1,1,2026,$2,$3,0,$4,$4,$5,false)`, [id, month, balance, instalment, balance - instalment]);
  return id;
}

/** An order as the app writes it (999z: a session user), as app_user with the admin's claims. */
async function order(r: Rig, employee: string, instalment: number, totalDebt: number): Promise<string> {
  const payable = (await one(r, `SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = '2175'`, [r.company])).id;
  return String((await asApp(r, `INSERT INTO payroll_garnishee_orders (company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance, start_date, payable_account_id, created_by)
      VALUES ($1, $2, 'emolument_attachment', 'CX-EAO', 'CX creditor', $3, $4, $4, '2026-01-01', $5, $6) RETURNING id`,
  [r.company, employee, instalment, totalDebt, payable, r.admin]))[0].id);
}

/** One statement as the app writes it: app_user with the admin's claims and the company active, committed. */
async function asApp(r: Rig, text: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const c = await r.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: r.admin, role: 'authenticated', aal: 'aal2' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [r.company]);
    const rows = (await c.query(text, params)).rows;
    await c.query('COMMIT');
    return rows;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** A created and calculated regular run, NOT authorised (calculatedRun authorises, which is approval evidence). */
async function calculated(r: Rig, month: number): Promise<string> {
  const made = await r.api.createRun(month);
  ok(made, 201);
  const id = String(made.body.data!.id);
  ok(await r.api.calculate(id));
  return id;
}

/** Everything a refused cancel must leave as it was. */
async function snapshot(r: Rig, run: string, loanId: string, orderId: string) {
  return {
    header: await one(r, 'SELECT status, approved_at, reopened_at, journal_entry_id, total_net::float8 AS net FROM payroll_run_headers WHERE id = $1', [run]),
    lines: Number((await one(r, 'SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [run])).n),
    loan: await one(r, 'SELECT outstanding_balance::float8 AS bal, total_principal_paid::float8 AS paid, status FROM payroll_loans WHERE id = $1', [loanId]),
    payments: (await r.pool.query('SELECT id, run_id FROM payroll_loan_payments WHERE loan_id = $1 ORDER BY id', [loanId])).rows,
    schedule: (await r.pool.query('SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id = $1 ORDER BY sequence', [loanId])).rows,
    deductions: (await r.pool.query('SELECT id, balance_applied FROM payroll_garnishee_deductions WHERE run_id = $1 ORDER BY id', [run])).rows,
    order: await one(r, 'SELECT balance::float8 AS bal, status FROM payroll_garnishee_orders WHERE id = $1', [orderId]),
    requests: (await r.pool.query(`SELECT id, status FROM approval_requests WHERE document_id = $1 ORDER BY id`, [run])).rows,
    audit: Number((await one(r, `SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1`, [r.company])).n),
  };
}
async function refused(r: Rig, run: string, why: RegExp, loanId = t.loan, orderId = t.order): Promise<void> {
  const before = await snapshot(r, run, loanId, orderId);
  const x = await cancelRun(r, run);
  expect(x.statusCode, JSON.stringify(x.body)).toBe(409);
  expect(x.body.error?.details?.code ?? x.body.error?.code).toBeDefined();
  expect(r.msg(x)).toMatch(why);
  expect(await snapshot(r, run, loanId, orderId)).toEqual(before);
}

beforeAll(async () => {
  a = await rig('w7-cx-a');
  b = await rig('w7-cx-b');
  await a.setup();
  await b.setup();
  t.emp = (await a.employee(20_000)).employee;
  tb.emp = (await b.employee(200_000)).employee;
  t.loan = await loan(a, t.emp, 3, 1_000, 10_000);
  tb.loan = await loan(b, tb.emp, 8, 10_000, 100_000);
  t.order = await order(a, t.emp, 600, 6_000);
  tb.order = await order(b, tb.emp, 6_000, 60_000);
}, 180_000);

afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]).catch(() => undefined);
    // tax_return_versions refuses every DELETE (969): its trigger off, DELETE, back ON ALWAYS, in ONE transaction (as
    // w6-oc-correction does), so no other session sees it off.
    const c = await r.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
      await c.query('DELETE FROM tax_return_versions WHERE company_id = $1', [r.company]);
      await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.teardown();
  }
  vi.useRealTimers();
}, 180_000);

describe('cancel a calculated regular run (W28)', () => {
  let march = '';
  it('releases the loan instalment exactly, drops the garnishee deduction, withdraws the request, deletes the run', async () => {
    march = await calculated(a, 3);
    expect(await one(a, 'SELECT outstanding_balance::float8 AS bal FROM payroll_loans WHERE id = $1', [t.loan])).toEqual({ bal: 9_000 });
    expect((await a.pool.query('SELECT balance_applied FROM payroll_garnishee_deductions WHERE run_id = $1', [march])).rows).toEqual([{ balance_applied: false }]);
    const raised = await a.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, {
      body: { action: 'request', documentType: 'pay_run', documentId: march },
    });
    ok(raised);
    const requestId = String((raised.body.data as { id: string }).id);
    const header = await one(a, 'SELECT total_gross::float8 AS gross, total_net::float8 AS net, total_paye::float8 AS paye FROM payroll_run_headers WHERE id = $1', [march]);
    const payment = String((await one(a, 'SELECT id FROM payroll_loan_payments WHERE run_id = $1', [march])).id);
    const deduction = String((await one(a, 'SELECT id FROM payroll_garnishee_deductions WHERE run_id = $1', [march])).id);

    expect((await cancelRun(b, march)).statusCode).toBe(404); // the other tenant cannot reach it
    const manager = await a.addUser('manager');
    expect((await cancelRun(a, march, { user: manager })).statusCode).toBe(403);

    const done = await cancelRun(a, march);
    ok(done);
    expect(done.body.data).toMatchObject({
      runId: march, deleted: true, payFrequency: 'monthly', periodStart: '2026-03-01', lines: 1,
      loanPaymentsReversed: 1, garnisheeDeductionsDropped: 1, approvalRequestWithdrawn: requestId,
    });
    expect(await one(a, 'SELECT count(*)::int AS n FROM payroll_run_headers WHERE id = $1', [march])).toEqual({ n: 0 });
    expect(await one(a, 'SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [march])).toEqual({ n: 0 });
    expect(await one(a, 'SELECT outstanding_balance::float8 AS bal, total_principal_paid::float8 AS paid, status FROM payroll_loans WHERE id = $1', [t.loan]))
      .toEqual({ bal: 10_000, paid: 0, status: 'active' });
    expect((await a.pool.query('SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id = $1', [t.loan])).rows).toEqual([{ paid_flag: false }]);
    expect(await one(a, 'SELECT count(*)::int AS n FROM payroll_loan_payments WHERE loan_id = $1', [t.loan])).toEqual({ n: 0 });
    expect(await one(a, 'SELECT principal_reversed::float8 AS p, stranded FROM payroll_loan_payment_reversals WHERE loan_id = $1', [t.loan]))
      .toEqual({ p: 1_000, stranded: false });
    expect(await one(a, 'SELECT count(*)::int AS n FROM payroll_garnishee_deductions WHERE id = $1', [deduction])).toEqual({ n: 0 });
    expect(await one(a, 'SELECT balance::float8 AS bal, status FROM payroll_garnishee_orders WHERE id = $1', [t.order])).toEqual({ bal: 6_000, status: 'active' });
    expect(await one(a, 'SELECT status, decision_notes FROM approval_requests WHERE id = $1', [requestId]))
      .toEqual({ status: 'rejected', decision_notes: 'Withdrawn: the pay run was cancelled.' });
    const audit = (await a.pool.query(`SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run' AND entity_id = $2 AND action = 'delete'`,
      [a.company, march])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.metadata).toMatchObject({
      event: 'cancelled', periodEnd: '2026-03-31', lineCount: '1', approvalRequestWithdrawn: requestId,
      loanPaymentIds: JSON.stringify([payment]), garnisheeDeductionIds: JSON.stringify([deduction]),
    });
    expect(Number(audit[0].changes.metadata.totalGross)).toBe(header.gross);
    expect(Number(audit[0].changes.metadata.totalNet)).toBe(header.net);
    expect(Number(audit[0].changes.metadata.totalPaye)).toBe(header.paye);
  });

  it('a new run for the period is created and calculated, taking the instalment again', async () => {
    march = await calculated(a, 3);
    expect(await one(a, 'SELECT outstanding_balance::float8 AS bal FROM payroll_loans WHERE id = $1', [t.loan])).toEqual({ bal: 9_000 });
    expect(await one(a, 'SELECT count(*)::int AS n FROM payroll_loan_payments WHERE run_id = $1', [march])).toEqual({ n: 1 });
  });

  it('refused, nothing changed: a draft, a run with a later calculated run, an approved request, an approved run, a reopened run', async () => {
    const draft = String((await a.api.createRun(4)).body.data!.id);
    await refused(a, draft, /has not been calculated/);
    ok(await a.api.calculate(draft));
    const april = draft;
    await refused(a, march, /later run of its pay frequency is already calculated/);
    await a.authorise(april);
    await refused(a, april, /approval request was approved/);
    ok(await a.api.approve(april));
    await refused(a, april, /it is approved/);
    ok(await a.api.reopen(april));
    const journal = String((await a.header(april)).journal_entry_id);
    ok(await a.api.reverse(journal));
    ok(await a.api.calculate(april));
    expect(await a.header(april)).toMatchObject({ status: 'calculated' });
    await refused(a, april, /approved before|reopened/);
  });

  it('refused on evidence outside the header: an audit event, an EMP201 return naming the run, a frozen payslip', async () => {
    const may = await calculated(a, 5);
    await a.pool.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes)
      VALUES ($1, $2, 'post', 'payroll_run', $3, $4)`, [a.company, a.admin, may, JSON.stringify({ fields: [], metadata: { event: 'executed' } })]);
    await refused(a, may, /audit trail records/);

    const june = await calculated(a, 6);
    await a.pool.query(`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through, finalised_by)
      VALUES ($1, 'EMP201', '2026-06-01', '2026-06-30', 1, $2, now(), $3)`, [a.company, JSON.stringify({ runs: [{ id: june, approvedPlanHash: null }] }), a.admin]);
    await refused(a, june, /EMP201 return names it/);

    const july = await calculated(a, 7);
    // A delivery is refused by 999o itself for a run that is not final, so the frozen payslip is the evidence a never-approved
    // run can be made to carry (a forged write: the app freezes slips only at approval).
    await a.pool.query(`UPDATE payroll_run_lines SET payslip_snapshot = '{"forged": true}'::jsonb WHERE run_id = $1`, [july]);
    await refused(a, july, /payslips were frozen or emailed/);
  });

  it('tenant B, 10x and a later month: restored exactly; A is untouched', async () => {
    const aLoan = await one(a, 'SELECT outstanding_balance::float8 AS bal FROM payroll_loans WHERE id = $1', [t.loan]);
    const run = await calculated(b, 8);
    expect(await one(b, 'SELECT outstanding_balance::float8 AS bal FROM payroll_loans WHERE id = $1', [tb.loan])).toEqual({ bal: 90_000 });
    expect((await cancelRun(a, run)).statusCode).toBe(404);
    const done = await cancelRun(b, run);
    ok(done);
    expect(done.body.data).toMatchObject({ deleted: true, loanPaymentsReversed: 1, garnisheeDeductionsDropped: 1, approvalRequestWithdrawn: null });
    expect(await one(b, 'SELECT outstanding_balance::float8 AS bal, total_principal_paid::float8 AS paid FROM payroll_loans WHERE id = $1', [tb.loan]))
      .toEqual({ bal: 100_000, paid: 0 });
    expect(await one(b, 'SELECT balance::float8 AS bal FROM payroll_garnishee_orders WHERE id = $1', [tb.order])).toEqual({ bal: 60_000 });
    expect(await one(a, 'SELECT outstanding_balance::float8 AS bal FROM payroll_loans WHERE id = $1', [t.loan])).toEqual(aLoan);
    ok(await b.api.createRun(8), 201);
  });
});
