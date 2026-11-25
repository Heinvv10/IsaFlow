/**
 * Wave 6 FQd, breaker #1622 L-J: the legacy EMP201 mark_submitted judges the month's runs under the lock the lifecycle
 * finalise takes (FOR SHARE on the month's run headers, in the request's transaction, held to its commit). A reopen
 * started after that check cannot commit before the mark does: it waits on the header (or gives up on its lock
 * bound), so the month is never marked filed with a run reopened under it. Since wave 7 EL (W25) the reopen, finishing
 * after the mark, is refused (409 EMP201_FILED): the run stays approved under the submitted EMP201.
 *
 * The window: emp201NotFinalRefusal is wrapped to pause after the check, while a reopen of the month's run is sent.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ pause: null as null | Promise<void>, reached: null as null | (() => void) }));
vi.mock('@/modules/accounting/services/returns/finaliseEmpReturn', async (orig) => {
  const m = await orig<typeof import('@/modules/accounting/services/returns/finaliseEmpReturn')>();
  return {
    ...m,
    emp201NotFinalRefusal: async (...args: Parameters<typeof m.emp201NotFinalRefusal>) => {
      const verdict = await m.emp201NotFinalRefusal(...args);
      if (gate.pause) { gate.reached?.(); await gate.pause; }
      return verdict;
    },
  };
});

import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import { dropReturnRows } from './w6-fqd-returns.helpers';
import runs from '../../pages/api/payroll/runs';
import emp201Draft from '../../pages/api/accounting/sars/sars-emp201';
import submissions from '../../pages/api/accounting/sars/sars-submissions';

let a: R;
let run = '';
let draft = '';

beforeAll(async () => {
  a = await rig('fqd-emp201-race');
  await a.setup();
  await a.employee(20000);
  run = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 10, year: 2026 } })).body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  const saved = await a.call(emp201Draft as Route, 'POST', '/api/accounting/sars/sars-emp201', undefined,
    { body: { periodStart: '2026-10-01', periodEnd: '2026-10-31' } });
  expect(saved.statusCode).toBe(201);
  draft = String(saved.body.data!.id);
}, 240_000);
afterAll(async () => { await dropReturnRows(a.pool, a.company); await cleanup(a); });

describe('L-J: a reopen racing the legacy mark_submitted', () => {
  it('cannot commit between the check and the mark: it finishes after the mark and is refused, or gives up', async () => {
    let release!: () => void;
    gate.pause = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { gate.reached = r; });
    const order: string[] = [];
    const mark = a.call(submissions as Route, 'POST', '/api/accounting/sars/sars-submissions', undefined,
      { body: { id: draft, action: 'mark_submitted', reference: '7123456789LC2610' } }).then((res) => { order.push('mark'); return res; });
    await reached; // the month was judged final, under FOR SHARE on its run headers
    const reopen = a.api.reopen(run).then((res) => { order.push('reopen'); return res; });
    await new Promise((r) => setTimeout(r, 1500));
    expect(order).toEqual([]); // the reopen waits on the header the mark holds
    gate.pause = null;
    release();
    const [m, r] = await Promise.all([mark, reopen]);
    expect(m.statusCode).toBe(200);
    expect(order[0]).toBe('mark');
    // Wave 7 EL (W25): the reopen judges the month after the mark committed, so it sees the month's EMP201 submitted and
    // is refused 409 EMP201_FILED (or gave up on its lock bound, 503). A 200 would be a run reopened under a filed EMP201.
    expect([409, 503]).toContain(r.statusCode);
    if (r.statusCode === 409) expect(JSON.stringify(r.body)).toContain('EMP201_FILED');
    expect((await a.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [run])).rows[0]!.status).toBe('approved');
    expect((await a.pool.query('SELECT status FROM sars_submissions WHERE id = $1', [draft])).rows[0]!.status).toBe('submitted');
  }, 60_000);
});
