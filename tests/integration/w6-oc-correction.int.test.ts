/**
 * Wave 6 OC, review #1620 final breaker M: correcting a paid, over-paid off-cycle bonus run.
 *  - before the month's EMP201 is filed: the paid run is reopened, its amount corrected (R50 000 -> R5 000), it is
 *    recalculated (its journal reversed, as for any reopened run) and approved again after its pay date (a run approved before is exempt from the pay-date refusal),
 *    and its PAYE drops;
 *  - an amount changes on a draft or calculated bonus run only, and sends it back to draft;
 *  - once the month's EMP201 is filed, the reopen is refused (409) saying so.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import amounts from '../../pages/api/payroll/runs/[id]/off-cycle-amounts';

// 23:15 SAST on 17 November: the minted sessions stay valid across the move to the 18th below.
vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let mid = '';
let bonusComponent = '';
let run = '';

const patch = (id: string, body: Record<string, unknown>) =>
  a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${id}/off-cycle-amounts`, id, { body });
const paye = async (id: string) => Number((await a.pool.query('SELECT COALESCE(SUM(paye), 0)::float8 AS p FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0].p);

beforeAll(async () => {
  a = await rig('w6-oc-correction');
  await a.setup();
  mid = (await a.employee(15_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-17', employees: [{ employeeId: mid, componentId: bonusComponent, amount: 50_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  run = String(made.body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST, 18 Nov: the bonus is paid
}, 120_000);

afterAll(async () => {
  // tax_return_versions is append-only for the app; the fixture row goes with its triggers off.
  await a.pool.query('ALTER TABLE tax_return_versions DISABLE TRIGGER USER');
  await a.pool.query('DELETE FROM tax_return_versions WHERE company_id = $1', [a.company]);
  await a.pool.query('ALTER TABLE tax_return_versions ENABLE TRIGGER USER');
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('correcting a paid, over-paid bonus run', () => {
  it('before filing: reopen, R50 000 -> R5 000, recalculate and approve again after the pay date; PAYE drops', async () => {
    const before = await paye(run);
    expect((await patch(run, { employeeId: mid, amount: 5_000 })).statusCode).toBe(409); // approved: reopen first
    const reopened = await a.api.reopen(run);
    expect(reopened.statusCode, a.msg(reopened)).toBe(200);
    const changed = await patch(run, { employeeId: mid, amount: 5_000 });
    expect(changed.statusCode, a.msg(changed)).toBe(200);
    expect((await a.header(run)).status).toBe('draft');
    expect(await paye(run)).toBe(0); // no lines on the old amount survive
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    // As for any reopened run, the journal posted at approval is reversed by hand before it is approved again.
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    const ok = await a.api.approve(run);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    const after = await paye(run);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(Number((await a.pool.query('SELECT gross_pay::float8 AS g FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0].g)).toBe(5_000);
  });

  it('after the month\'s EMP201 is filed, the paid run is not reopened (409, saying so)', async () => {
    await a.pool.query(`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, status, figures,
      posted_through, finalised_by, filed_by, filed_at) VALUES ($1, 'EMP201', '2026-11-01', '2026-11-30', 1, 'filed', '{}'::jsonb, now(), $2, $2, now())`,
    [a.company, a.admin]);
    const refused = await a.api.reopen(run);
    expect(refused.statusCode).toBe(409);
    expect(a.msg(refused)).toMatch(/its month's EMP201 is filed, so it is not reopened/);
    expect((await a.header(run)).status).toBe('approved');
    // The 999x guard holds the same rule below the service: an approved run's amount does not change.
    await expect(a.pool.query('UPDATE payroll_off_cycle_employees SET amount = 1 WHERE run_id = $1', [run]))
      .rejects.toThrow(/only a draft or calculated bonus run's amount changes/);
  });
});
