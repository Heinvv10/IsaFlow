/**
 * Wave 6 FQd, breaker #1622 M-E (coordinator: floor at the MONTH, not the run): a weekly run W1 caught up by the month's
 * monthly run M, then reopened and corrected DOWN, carries NEGATIVE SDL, a within-month refund of the over-catch-up. The
 * month's SDL is then 1% of its leviable pay exactly, the journal debits 2160 for the refund and balances, and while W1
 * is reopened the EMP201 for the month cannot be finalised (a run of the period is not final).
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import finaliseRoute from '../../pages/api/accounting/sars/returns/[form]/finalise';
import { generateEMP201 } from '@/modules/accounting/services/reports/sarsService';
import { request, response } from './mfa-impersonation-postgres.helpers';

let a: R;
const create = (body: unknown) => a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const sdlOf = async (id: string) => (await a.pool.query(
  'SELECT COALESCE(sum(sdl),0)::float8 sdl, COALESCE(sum(sdl_leviable),0)::float8 lev, bool_and(sdl_exempt) exempt FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0]!;
const journalLines = async (runId: string) => (await a.pool.query(
  `SELECT a.account_code, l.debit::float8 AS debit, l.credit::float8 AS credit, l.description
     FROM payroll_run_headers h JOIN gl_journal_lines l ON l.journal_entry_id = h.journal_entry_id
     JOIN gl_accounts a ON a.id = l.gl_account_id WHERE h.id = $1 ORDER BY a.account_code`, [runId])).rows;
type Res = { statusCode: number; body: { data?: unknown; error?: { message?: string } } };
async function finaliseEmp201(): Promise<Res> {
  const req = request({ 'sb-access-token': a.tokens[a.admin]!, active_company_id: a.company }, 'POST') as never as
    { url: string; query: Record<string, unknown>; body: unknown };
  req.query = { form: 'emp201' };
  req.url = '/api/accounting/sars/returns/emp201/finalise';
  req.body = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
  const out = response();
  await (finaliseRoute as Route)(req as never, out.res as never);
  return out.state as Res;
}

let w1 = '';
let m = '';
let salaryRow = '';
beforeAll(async () => {
  a = await rig('fqd-sdl-refund');
  await a.setup();
  await a.employee(50000);
  const wk = await a.employee(1000);
  salaryRow = wk.salaryRow;
  expect((await a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${wk.employee}/pay-frequency`, wk.employee,
    { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
  w1 = String((await create({ frequency: 'weekly', periodStart: '2026-10-05' })).body.data!.id);
  expect((await a.api.calculate(w1)).statusCode).toBe(200);
  expect((await a.api.approve(w1)).statusCode).toBe(200);
  m = String((await create({ month: 10, year: 2026 })).body.data!.id);
  expect((await a.api.calculate(m)).statusCode).toBe(200);
  expect((await a.api.approve(m)).statusCode).toBe(200);
}, 240_000);
afterAll(async () => { await cleanup(a); });

describe('M-E: a caught-up run corrected down refunds the over-catch-up within the month', () => {
  it('M caught W1 up (1% of R51 000), W1 itself was exempt', async () => {
    expect([(await sdlOf(w1)).sdl, (await sdlOf(m)).sdl]).toEqual([0, 510]);
  });

  it('while W1 is reopened, the October EMP201 cannot be finalised (409, the run is not final)', async () => {
    expect((await a.api.reopen(w1)).statusCode).toBe(200);
    const je = (await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [w1])).rows[0]!.journal_entry_id;
    if (je) expect((await a.api.reverse(String(je))).statusCode).toBe(200);
    const res = await finaliseEmp201();
    expect([res.statusCode, res.body.error?.message]).toEqual([409, expect.stringContaining('not final under the approval rule')]);
  });

  it('W1 re-approved at R500 carries -R5.00 SDL; the month is 1% of R50 500 = R505 on the EMP201', async () => {
    await a.setSalary(salaryRow, 500);
    expect((await a.api.calculate(w1)).statusCode).toBe(200);
    const explained = (await a.pool.query("SELECT explanation->'sdl' AS sdl FROM payroll_run_lines WHERE run_id = $1", [w1])).rows[0]!.sdl as
      { steps?: Array<{ key: string; label: string; amount: number }> } | null;
    const step = explained?.steps?.find((s) => s.key === 'sdl.month');
    expect([step?.amount, step?.label]).toEqual([-5, expect.stringContaining("reduces the month's SDL to 1%")]);
    expect((await a.api.approve(w1)).statusCode).toBe(200);
    expect(await sdlOf(w1)).toEqual({ sdl: -5, lev: 500, exempt: false });
    expect((await generateEMP201(a.company, '2026-10-01', '2026-10-31')).totalSDL).toBe(505);
  });

  it('the W1 journal debits 2160 by R5.00 and balances; the posted 2160 balance for the month is R505 payable', async () => {
    const lines = await journalLines(w1);
    expect(lines.filter((l) => l.account_code === '2160').map((l) => [l.debit, l.credit])).toEqual([[5, 0]]);
    const dr = lines.reduce((t, l) => t + l.debit, 0);
    const cr = lines.reduce((t, l) => t + l.credit, 0);
    expect(Math.round((dr - cr) * 100)).toBe(0);
    expect((await a.ledger())['2160']).toBeCloseTo(-505, 2);
  });

  it('the EMP201 for October (an ended month) now finalises with SDL R505', async () => {
    const res = await finaliseEmp201();
    expect(res.statusCode).toBe(200);
    expect((res.body.data as { version?: { figures?: { totalSDL?: number } } }).version?.figures?.totalSDL).toBe(505);
  });
});
