/**
 * Wave 7 GC2 (W12 part 2; Hein's ruling 5; grill F13; migration 1057): garnishee creditors paid from the salary bank
 * file, through the real routes, withAuth, app_user and RLS, on a disposable fixture (rig -> assertDisposable), two
 * tenants (B at 10x the amounts, with a later-dated run).
 *
 *  - generate: an order with no creditor bank details refuses the file by name (CREDITORS_NOT_PAYABLE), writing nothing;
 *    with details, the file carries one credit record per order (byte fixture), its total is net pay + deductions, and
 *    the creditor line is stored with the account as paid and the details' version; a manager's first entry is named
 *    in the warnings (GC1 design input #2);
 *  - confirm: posts ONE balanced journal, DR the garnishee payable / CR the account net pay used, equal to the
 *    deductions, dated the action date; the payable nets to nil after approve + confirm; a second confirm posts nothing;
 *    the journal cannot be reversed; a reopen after confirm keeps its warning and reverses nothing;
 *  - refusals change no row: a confirm in a closed fiscal period (PERIOD_CLOSED), creditor details changed since the file
 *    was made (CREDITOR_DETAILS_CHANGED; then confirmed under the paidAsGenerated attestation, audited);
 *  - mark paid: the file path counts the creditor lines; the typed path warns GARNISHEE_PAYABLE_OPEN naming the creditor;
 *  - 1057 as app_user: a forged creditor line and a confirm without the creditor journal (the old colour's) are refused.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import orders from '../../pages/api/payroll/employees/[id]/garnishee-orders/index';
import orderRoute from '../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';
import markPaid from '../../pages/api/payroll/runs/[id]/mark-paid';
import { todayInSast } from '@/lib/saDateParser';
import { rig, type Route } from './brkr.helpers';
import { act, bank, cleanup, enable, files, generate, payingAccount, reason, type R } from './payroll-bank-file.helpers';

let a: R;
let b: R;
const TODAY = todayInSast();
const emp: Record<'a' | 'b', string> = { a: '', b: '' };
const order: Record<'a' | 'b', string> = { a: '', b: '' };
let manager = '';

const BANK = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: 'Acme Credit Ltd' };
const OTHER = { ...BANK, accountNumber: '62009999999' };
const ORDER = { kind: 'emolument_attachment', reference: 'EAO 1/2027', creditorName: 'Acme Credit', priority: 10, endDate: null };

const putBank = (r: R, employee: string, id: string, body: unknown, user?: string) => {
  const route = ((req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { ...req.query, orderId: id };
    return (orderRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }) as unknown as Route;
  return r.call(route, 'PUT', `/api/payroll/employees/${employee}/garnishee-orders/${id}`, employee, { body, user });
};
const confirm = (r: R, run: string, file: string, body: unknown = {}) => act(r, run, file, 'confirm', { body });
const mark = (r: R, run: string, body: unknown = {}) => r.call(markPaid as Route, 'POST', `/api/payroll/runs/${run}/mark-paid`, run, { body });
const creditorJournals = async (r: R) => (await r.pool.query(
  `SELECT e.id, e.status, e.entry_date::text AS entry_date, e.source, e.source_record_id, e.reversed_at
     FROM gl_journal_entries e WHERE e.company_id = $1 AND e.description LIKE 'Garnishee creditors paid by salary bank file%'
    ORDER BY e.created_at`, [r.company])).rows;
const linesOf = async (r: R, journal: string) => (await r.pool.query(
  `SELECT a.account_code AS code, l.debit::float8 AS debit, l.credit::float8 AS credit FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id WHERE l.journal_entry_id = $1 ORDER BY l.debit DESC`, [journal])).rows;
/** Posted balance (debit - credit) of an account code over all the company's posted journals. */
const balance = async (r: R, code: string) => Number((await r.pool.query(
  `SELECT COALESCE(sum(l.debit - l.credit), 0)::float8 AS n FROM gl_journal_lines l
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE e.company_id = $1 AND e.status = 'posted' AND a.account_code = $2`, [r.company, code])).rows[0]!.n);
const deducted = async (r: R, run: string) => Number((await r.pool.query(
  'SELECT COALESCE(sum(amount), 0)::float8 AS n FROM payroll_garnishee_deductions WHERE run_id = $1', [run])).rows[0]!.n);
const payableCode = async (r: R) => String((await r.pool.query(
  "SELECT account_code FROM gl_accounts WHERE company_id = $1 AND account_name = 'Garnishee Orders Payable'", [r.company])).rows[0]!.account_code);
const fileRow = async (r: R, id: string) => (await r.pool.query(
  'SELECT status, creditor_journal_id FROM payroll_bank_files WHERE id = $1', [id])).rows[0]!;
const net = async (r: R, run: string) => Math.round((await r.header(run)).net * 100);

async function asAppUser(r: R, text: string, values: unknown[]): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: r.admin, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [r.company]);
    await c.query(text, values);
    await c.query('COMMIT');
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { await c.end(); }
}

/** An approved run of month (2026), its journal posted through the real routes. */
async function approved(r: R, month: number): Promise<string> {
  const run = await r.calculatedRun(month, 2026);
  const ap = await r.api.approve(run);
  if (ap.statusCode !== 200) throw new Error(`approve: ${ap.statusCode} ${JSON.stringify(ap.body)}`);
  return run;
}

beforeAll(async () => {
  a = await rig('w7-gc2-a');
  b = await rig('w7-gc2-b');
  for (const [k, r, salary, instalment] of [['a', a, 200000, 10000], ['b', b, 2000000, 100000]] as const) {
    await r.setup();
    emp[k] = (await r.employee(salary)).employee;
    await enable(r);
    await payingAccount(r);
    await bank(r, emp[k], '4071234567');
    const made = await r.call(orders as Route, 'POST', `/api/payroll/employees/${emp[k]}/garnishee-orders`, emp[k],
      { body: { ...ORDER, instalment, totalDebt: instalment * 50, startDate: '2026-01-01' } });
    if (made.statusCode !== 201) throw new Error(`order: ${made.statusCode} ${JSON.stringify(made.body)}`);
    order[k] = String(made.body.data!.id);
  }
  manager = await b.addUser('manager');
}, 240_000);
afterAll(async () => {
  for (const r of [a, b].filter(Boolean)) {
    await r.pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND status = 'closed'", [r.company]);
    await r.pool.query('DELETE FROM payroll_bank_file_items WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_bank_files WHERE company_id = $1', [r.company]);
    await r.pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE company_id = $1", [r.company]);
    await r.pool.query('UPDATE payroll_garnishee_deductions SET balance_applied = false WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_deductions WHERE company_id = $1', [r.company]);
    await r.pool.query('DELETE FROM payroll_garnishee_orders WHERE company_id = $1', [r.company]);
    await cleanup(r);
  }
}, 120_000);

describe('garnishee creditors in the salary bank file', () => {
  let runA = '';
  let fileA = '';

  it('refuses the file by name while an order has no creditor bank details, writing nothing', async () => {
    runA = await approved(a, 11);
    expect(await deducted(a, runA)).toBe(10000);
    const res = await generate(a, runA, { actionDate: TODAY });
    expect([res.statusCode, reason(res)], JSON.stringify(res.body)).toEqual([409, 'CREDITORS_NOT_PAYABLE']);
    expect(res.body.error.details.problems).toEqual(['Acme Credit (employee BRK-1): the garnishee order has no creditor bank details']);
    expect(await files(a)).toEqual([]);
  });

  it('pays the creditor as one more credit record, snapshotted with the details version; total = net + deductions', async () => {
    expect((await putBank(a, emp.a, order.a, BANK)).statusCode).toBe(200);
    const res = await generate(a, runA, { actionDate: TODAY });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const body = res.body.data!;
    expect(body.totalCents).toBe(await net(a, runA) + 1_000_000);
    expect(body.lineCount).toBe(2);
    const records = String(body.content).split('\r\n').slice(0, -1);
    expect(records.map((l) => l.slice(0, 2))).toEqual(['02', '04', '10', '10', '12', '92', '94']);
    // Byte fixture (FNB ACB Feb 2023, record 10, pp.3-8): the creditor's record, field by field.
    expect(records[3]).toBe('10' + '250655' + '62000000001' + '0000' + '000002' + '250655' + '62001234567' + '1' + '00001000000'
      + '00000000' + '0' + '000' + 'EAO 1/2027'.padEnd(20, ' ') + '0'.repeat(10) + 'Acme Credit Ltd' + '0'.repeat(15) + '0'.repeat(50));
    const item = (await a.pool.query(
      `SELECT i.employee_id, i.amount_cents::int AS cents, i.creditor_account_number, i.creditor_branch_code, i.creditor_account_holder,
              i.creditor_bank_set_at = o.creditor_bank_set_at AS same_version
         FROM payroll_bank_file_items i JOIN payroll_garnishee_orders o ON o.id = i.garnishee_order_id
        WHERE i.file_id = $1`, [body.id])).rows;
    expect(item).toEqual([{ employee_id: emp.a, cents: 1_000_000, creditor_account_number: '62001234567', creditor_branch_code: '250655',
      creditor_account_holder: 'Acme Credit Ltd', same_version: true }]);
    expect(body.warnings).toEqual([]);
    expect(await creditorJournals(a)).toEqual([]); // nothing posts at generate: the bank has not paid yet
    fileA = String(body.id);
  });

  it('1057 refuses a forged creditor line and a confirm without the creditor journal, as app_user', async () => {
    await expect(asAppUser(a,
      `INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents, garnishee_order_id, creditor_bank_name,
         creditor_branch_code, creditor_account_number, creditor_account_type, creditor_bank_set_at)
       SELECT company_id, $1, employee_id, amount_cents + 1, garnishee_order_id, creditor_bank_name, creditor_branch_code,
              '62009999999', creditor_account_type, creditor_bank_set_at FROM payroll_bank_file_items WHERE file_id = $1 AND garnishee_order_id IS NOT NULL`,
      [fileA])).rejects.toThrow(/creditor line pays exactly/);
    await expect(asAppUser(a, "UPDATE payroll_bank_files SET status = 'confirmed', confirmed_by = 'x', confirmed_at = now() WHERE id = $1", [fileA]))
      .rejects.toThrow(/confirmed with its posted creditor journal/);
    expect(await fileRow(a, fileA)).toEqual({ status: 'generated', creditor_journal_id: null });
  });

  it('confirm posts one balanced journal clearing the payable; a second confirm posts nothing; it cannot be reversed', async () => {
    const code = await payableCode(a);
    expect(await balance(a, code)).toBe(-10000); // the approval credited the deduction
    const bankBefore = await balance(a, '1110');
    const res = await confirm(a, runA, fileA);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const [j, ...more] = await creditorJournals(a);
    expect(more).toEqual([]);
    expect(j).toMatchObject({ status: 'posted', entry_date: TODAY, source: 'auto_payroll', source_record_id: fileA, reversed_at: null });
    expect(res.body.data!.creditorJournalId).toBe(j!.id);
    expect(await linesOf(a, j!.id)).toEqual([{ code, debit: 10000, credit: 0 }, { code: '1110', debit: 0, credit: 10000 }]);
    expect(await balance(a, code)).toBe(0);
    expect(await balance(a, '1110')).toBe(bankBefore - 10000);
    expect(await fileRow(a, fileA)).toEqual({ status: 'confirmed', creditor_journal_id: j!.id });

    const again = await confirm(a, runA, fileA);
    expect([again.statusCode, reason(again)]).toEqual([409, 'NOT_GENERATED']);
    expect((await creditorJournals(a)).length).toBe(1);

    const reversed = await a.api.reverse(j!.id);
    expect(reversed.statusCode, JSON.stringify(reversed.body)).toBeGreaterThanOrEqual(400);
    expect(reversed.statusCode).toBeLessThan(500);
    expect((await creditorJournals(a))[0]!.reversed_at).toBeNull();
  });

  it('a reopen after confirm keeps its warning and reverses nothing of the creditor journal', async () => {
    const res = await a.api.reopen(runA);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.warnings.map((w: { code: string }) => w.code)).toContain('BANK_FILE_CONFIRMED');
    const [j] = await creditorJournals(a);
    expect(j).toMatchObject({ status: 'posted', reversed_at: null });
    expect(await a.pool.query('SELECT 1 FROM gl_journal_entries WHERE reversal_of_id = $1', [j!.id]).then((q) => q.rowCount)).toBe(0);
  });

  let runB = '';
  let fileB = '';
  it('names a manager\'s first creditor entry in the warnings (accepted, GC1 input #2); B at 10x', async () => {
    runB = await b.calculatedRun(11, 2026);
    expect((await putBank(b, emp.b, order.b, BANK, manager)).statusCode).toBe(200); // first entry, run only calculated
    const ap = await b.api.approve(runB);
    expect(ap.statusCode, JSON.stringify(ap.body)).toBe(200);
    expect(await deducted(b, runB)).toBe(100000);
    const res = await generate(b, runB, { actionDate: TODAY });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.totalCents).toBe(await net(b, runB) + 10_000_000);
    expect(res.body.data!.warnings).toEqual([expect.stringMatching(/^Acme Credit \(employee BRK-\d+\): the creditor bank details \(account ending 4567, R.?100.000\.00\) were entered by a manager, not an owner or admin/)]);
    fileB = String(res.body.data!.id);
  });

  it('refuses a confirm in a closed fiscal period and one whose creditor details changed since the file, writing nothing', async () => {
    const closed = await b.pool.query(
      "UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date <= $2::date AND end_date >= $2::date RETURNING period_name",
      [b.company, TODAY]);
    expect(closed.rowCount).toBe(1);
    const res = await confirm(b, runB, fileB);
    expect([res.statusCode, reason(res)], JSON.stringify(res.body)).toEqual([409, 'PERIOD_CLOSED']);
    expect(res.body.error.message).toContain(String(closed.rows[0]!.period_name));
    expect(await fileRow(b, fileB)).toEqual({ status: 'generated', creditor_journal_id: null });
    expect(await creditorJournals(b)).toEqual([]);
    await b.pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1 AND status = 'closed'", [b.company]);

    expect((await putBank(b, emp.b, order.b, OTHER)).statusCode).toBe(200); // owner / admin change after the file
    const changed = await confirm(b, runB, fileB);
    expect([changed.statusCode, reason(changed)]).toEqual([409, 'CREDITOR_DETAILS_CHANGED']);
    expect(await fileRow(b, fileB)).toEqual({ status: 'generated', creditor_journal_id: null });
    expect(await creditorJournals(b)).toEqual([]);

    const attested = await confirm(b, runB, fileB, { paidAsGenerated: true });
    expect(attested.statusCode, JSON.stringify(attested.body)).toBe(200);
    const [j] = await creditorJournals(b);
    expect(await linesOf(b, j!.id)).toEqual([{ code: await payableCode(b), debit: 100000, credit: 0 }, { code: '1110', debit: 0, credit: 100000 }]);
    const audit = (await b.pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_bank_file' AND action = 'update' ORDER BY created_at DESC LIMIT 1",
      [b.company])).rows[0]!.changes;
    expect(audit.metadata).toMatchObject({ paidAsGenerated: 'attested', creditorJournalId: j!.id, creditorCents: '10000000' });
    expect(await balance(b, await payableCode(b))).toBe(0);
  });

  it('mark paid: the file path counts the creditor lines; the typed path warns the payable is still open', async () => {
    const byFile = await mark(b, runB);
    expect(byFile.statusCode, JSON.stringify(byFile.body)).toBe(200);
    expect(byFile.body.data).toMatchObject({ status: 'paid', evidence: 'bank_file', warnings: [] });

    const later = await approved(b, 12); // a later-dated window: December's run deducts again
    expect(await deducted(b, later)).toBe(100000);
    const typed = await mark(b, later, { reference: 'FNB EFT 77', paidOn: TODAY });
    expect(typed.statusCode, JSON.stringify(typed.body)).toBe(200);
    expect(typed.body.data!.warnings).toEqual([expect.stringMatching(/^GARNISHEE_PAYABLE_OPEN: R.?100.000\.00 deducted for Acme Credit \(employee BRK-\d+\) is still owed/)]);
    expect(await balance(b, await payableCode(b))).toBe(-100000);
    // Tenant A is untouched by B.
    expect((await creditorJournals(a)).length).toBe(1);
  });
});
