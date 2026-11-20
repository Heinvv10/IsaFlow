/**
 * Wave 6 FQd, breaker #1622 L-H (coordinator: a net-negative 5200 posts as a CREDIT, a reduction of expense; never a
 * refusal). Three weekly employees at R100 a week (two on one cost centre, one on another) and one monthly at R50 000:
 * W1 (exempt alone) and the monthly run M (catching the month up: 1% of R50 300 = R503) are approved. W1 is reopened
 * and every weekly salary set to R0: its SDL is -R3.00, more than its cost, so its labour is -R3.00. It approves, the
 * journal credits 5200 with the R3.00 on each cost centre's line and debits 2160, balanced; the month's EMP201 SDL is
 * 1% of R50 000 = R500, and the GL's 2160 says the same.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { generateEMP201 } from '@/modules/accounting/services/reports/sarsService';

let a: R;
let w1 = '';
const weekly: Array<{ employee: string; salaryRow: string }> = [];
const create = (body: unknown) => a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const journal = async (runId: string) => (await a.pool.query(
  `SELECT ac.account_code, l.debit::float8 AS debit, l.credit::float8 AS credit, l.cc1_id
     FROM payroll_run_headers h JOIN gl_journal_lines l ON l.journal_entry_id = h.journal_entry_id
     JOIN gl_accounts ac ON ac.id = l.gl_account_id WHERE h.id = $1 ORDER BY ac.account_code, l.credit`, [runId])).rows;

beforeAll(async () => {
  a = await rig('fqd-sdl-refund-labour');
  await a.setup();
  const cc = async (code: string) => String((await a.pool.query(
    "INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, $2, $2, 'cc1') RETURNING id", [a.company, code])).rows[0]!.id);
  const centres = [await cc('FQD-A'), await cc('FQD-B')];
  await a.employee(50000);
  for (let i = 0; i < 3; i += 1) {
    const e = await a.employee(100);
    expect((await a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${e.employee}/pay-frequency`, e.employee,
      { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
    await a.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [centres[i === 2 ? 1 : 0], e.employee]);
    weekly.push(e);
  }
  w1 = String((await create({ frequency: 'weekly', periodStart: '2027-01-04' })).body.data!.id);
  expect((await a.api.calculate(w1)).statusCode).toBe(200);
  expect((await a.api.approve(w1)).statusCode).toBe(200);
  const m = String((await create({ month: 1, year: 2027 })).body.data!.id);
  expect((await a.api.calculate(m)).statusCode).toBe(200);
  expect((await a.api.approve(m)).statusCode).toBe(200);
  expect((await a.pool.query('SELECT sum(sdl)::float8 s FROM payroll_run_lines WHERE run_id = $1', [m])).rows[0]!.s).toBe(503);
}, 240_000);
afterAll(async () => { await cleanup(a); });

describe('L-H: an SDL refund larger than the run\'s labour cost', () => {
  it('W1 at R0 a week carries -R3.00 SDL and approves (no "negative amount on 5200")', async () => {
    expect((await a.api.reopen(w1)).statusCode).toBe(200);
    const je = (await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [w1])).rows[0]!.journal_entry_id;
    if (je) expect((await a.api.reverse(String(je))).statusCode).toBe(200);
    for (const e of weekly) await a.setSalary(e.salaryRow, 0);
    expect((await a.api.calculate(w1)).statusCode).toBe(200);
    expect((await a.pool.query('SELECT sum(sdl)::float8 s FROM payroll_run_lines WHERE run_id = $1', [w1])).rows[0]!.s).toBe(-3);
    const ap = await a.api.approve(w1);
    expect([ap.statusCode, a.msg(ap) ?? null]).toEqual([200, null]);
  });

  it('its journal credits 5200 (every labour line a credit) and debits 2160 by R3.00, balanced', async () => {
    const lines = await journal(w1);
    const labour = lines.filter((l) => l.account_code === '5200');
    expect(labour.length).toBeGreaterThan(0);
    expect(labour.every((l) => l.debit === 0 && l.credit > 0)).toBe(true);
    expect(Math.round(labour.reduce((t, l) => t + l.credit, 0) * 100)).toBe(300);
    expect(lines.filter((l) => l.account_code === '2160').map((l) => [l.debit, l.credit])).toEqual([[3, 0]]);
    expect(Math.round(lines.reduce((t, l) => t + l.debit - l.credit, 0) * 100)).toBe(0);
  });

  it('the EMP201 SDL is 1% of the month (R500), and the GL 2160 balance equals it', async () => {
    expect((await generateEMP201(a.company, '2027-01-01', '2027-01-31')).totalSDL).toBe(500);
    expect((await a.ledger())['2160']).toBeCloseTo(-500, 2);
  });
});
