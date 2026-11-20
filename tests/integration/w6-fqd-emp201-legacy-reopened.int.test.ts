/**
 * Wave 6 FQd, breaker #1622 (coordinator ruling: EMP201 filing refuses a month with a reopened run, on every path). The
 * legacy path, POST /api/accounting/sars/sars-emp201 (draft) then sars-submissions mark_submitted, refuses a month whose
 * pay run is not final, with the lifecycle finalise's words; once the run is approved again it files.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import { dropReturnRows } from './w6-fqd-returns.helpers';
import runs from '../../pages/api/payroll/runs';
import emp201Draft from '../../pages/api/accounting/sars/sars-emp201';
import submissions from '../../pages/api/accounting/sars/sars-submissions';

let a: R;
let run = '';
let draft = '';
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
const NOT_FINAL = 'Pay run for 10/2026 is not final under the approval rule, so the EMP201 would not match the payslips. Approve or cancel it first.';
const saveDraft = () => a.call(emp201Draft as Route, 'POST', '/api/accounting/sars/sars-emp201', undefined, { body: PERIOD });
const markSubmitted = () => a.call(submissions as Route, 'POST', '/api/accounting/sars/sars-submissions', undefined,
  { body: { id: draft, action: 'mark_submitted', reference: '7123456789LC2610' } });

beforeAll(async () => {
  a = await rig('fqd-emp201-legacy');
  await a.setup();
  await a.employee(20000);
  run = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 10, year: 2026 } })).body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  const saved = await saveDraft();
  expect(saved.statusCode).toBe(201);
  draft = String(saved.body.data!.id);
  expect((await a.api.reopen(run)).statusCode).toBe(200);
}, 240_000);
afterAll(async () => { await dropReturnRows(a.pool, a.company); await cleanup(a); });

describe('the legacy EMP201 path refuses a month with a reopened run', () => {
  it('mark_submitted: 409 with the lifecycle\'s words, and the draft stays a draft', async () => {
    const res = await markSubmitted();
    expect([res.statusCode, a.msg(res)]).toEqual([409, NOT_FINAL]);
    expect((await a.pool.query('SELECT status FROM sars_submissions WHERE id = $1', [draft])).rows[0]!.status).toBe('draft');
  });

  it('the draft save: 409 with the same words', async () => {
    const res = await saveDraft();
    expect([res.statusCode, a.msg(res)]).toEqual([409, NOT_FINAL]);
  });

  it('approved again, the month files', async () => {
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    expect((await a.api.approve(run)).statusCode).toBe(200);
    expect((await markSubmitted()).statusCode).toBe(200);
  });
});
