/**
 * Wave 6 OC, review #1620 final breaker M: correcting a paid, over-paid off-cycle bonus run.
 *  - before the month's EMP201 is filed: the paid run is reopened, its amount corrected (R50 000 -> R5 000), it is
 *    recalculated (its journal reversed, as for any reopened run) and approved again after its pay date (a run approved before is exempt from the pay-date refusal),
 *    and its PAYE drops;
 *  - an amount changes on a draft or calculated bonus run only, with an audit row (old and new), and sends it back to
 *    draft: the stale costing cannot be submitted or approved until it is recalculated; the journal is reversed and a new
 *    one posted for the corrected amount;
 *  - the route: payroll-detail roles only (a viewer: 403 on GET and PATCH, nothing returned or written), owner or admin
 *    for PATCH (a manager: 403), a cookie session only (an agent's bearer token: 401);
 *  - the 999x guard: only the amount changes, and only on a draft or calculated bonus run;
 *  - once the month's EMP201 is filed, the reopen is refused (409) saying so.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
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
  // tax_return_versions refuses every DELETE (969): its immutability trigger off, DELETE, back ON ALWAYS, in ONE
  // transaction on one client (as k053-chain.helpers does), so no other session ever sees it off.
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await c.query('DELETE FROM tax_return_versions WHERE company_id = $1', [a.company]);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('correcting a paid, over-paid bonus run', () => {
  it('before filing: reopen, R50 000 -> R5 000, recalculate and approve again after the pay date; PAYE drops', async () => {
    const before = await paye(run);
    expect((await patch(run, { employeeId: mid, amount: 5_000 })).statusCode).toBe(409); // approved: reopen first
    // Delta L2: the same ceiling as create (R100 000 000), refused before anything is read.
    const tooBig = await patch(run, { employeeId: mid, amount: 900_000_000 });
    expect(tooBig.statusCode).toBe(400);
    expect(a.msg(tooBig)).toMatch(/at most R\s100\s000\s000\.00/);
    const reopened = await a.api.reopen(run);
    expect(reopened.statusCode, a.msg(reopened)).toBe(200);
    const changed = await patch(run, { employeeId: mid, amount: 5_000 });
    expect(changed.statusCode, a.msg(changed)).toBe(200);
    expect((await a.header(run)).status).toBe('draft');
    expect(await paye(run)).toBe(0); // no lines on the old amount survive
    const audit = (await a.pool.query(`SELECT action, user_id::text AS user_id, changes FROM audit_log
      WHERE company_id = $1 AND entity_type = 'payroll_run' AND entity_id = $2 AND action = 'update'
        AND changes->'fields' @> '[{"field": "off_cycle_bonus_amount"}]'::jsonb`, [a.company, run])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(a.admin);
    expect(audit[0].changes.fields).toEqual([{ field: 'off_cycle_bonus_amount', old: '50000.00', new: '5000.00', label: 'Bonus amount' }]);
    // As for any reopened run, the journal posted at approval is reversed by hand before it is approved again.
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    // The stale costing (nothing calculated since the edit) is neither submitted nor approved.
    const stale = await a.api.approve(run);
    expect(stale.statusCode).not.toBe(200);
    expect((await a.header(run)).status).toBe('draft');
    expect((await a.pool.query(`SELECT 1 FROM approval_requests WHERE company_id = $1 AND document_id = $2 AND status = 'pending'`, [a.company, run])).rows).toHaveLength(0);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    // Delta L1: the 999x guard changes an amount on a DRAFT run only; a calculated run's lines were costed on it.
    await expect(a.pool.query('UPDATE payroll_off_cycle_employees SET amount = 4999 WHERE run_id = $1', [run]))
      .rejects.toThrow(/only a draft bonus run's amount changes/);
    // The first change after the reopen kept the amount last approved.
    expect((await a.pool.query('SELECT approved_amount::float8 AS x FROM payroll_off_cycle_employees WHERE run_id = $1', [run])).rows[0].x).toBe(50_000);
    const ok = await a.api.approve(run);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    const after = await paye(run);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(Number((await a.pool.query('SELECT gross_pay::float8 AS g FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0].g)).toBe(5_000);
    // The journal: the original (R50 000) reversed, its reversal posted, and a new one posted for R5 000.
    const bonusJournals = (await a.journals('*')).filter((j) => String(j.description).includes('bonus') || j.reversal_of_id === journal);
    const original = bonusJournals.find((j) => j.id === journal)!;
    const reversal = bonusJournals.find((j) => j.reversal_of_id === journal)!;
    const reposted = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id);
    expect(original.reversed).toBe(true);
    expect(reversal.total_debit).toBeCloseTo(original.total_debit, 2);
    expect(reposted).not.toBe(journal);
    const fresh = bonusJournals.find((j) => j.id === reposted)!;
    expect(fresh.status).toBe('posted');
    expect(fresh.total_debit).toBeLessThan(original.total_debit);
    // The employment cost debit (gross + the employer's UIF and SDL, one line): R50 677.12 on the original, and on the
    // new journal exactly the corrected run's own cost.
    const debits = async (je: string) => (await a.pool.query('SELECT debit::float8 AS d FROM gl_journal_lines WHERE journal_entry_id = $1 AND debit > 0', [je])).rows.map((r) => r.d);
    const cost = Number((await a.pool.query(`SELECT SUM(gross_pay + uif_employer + sdl)::float8 AS c FROM payroll_run_lines WHERE run_id = $1`, [run])).rows[0].c);
    expect(cost).toBeGreaterThan(5_000);
    expect(cost).toBeLessThan(5_200);
    expect(await debits(journal)).toEqual([50_677.12]);
    expect(await debits(reposted)).toEqual([cost]);
  });

  it('delta M1: after its pay date a correction only lowers the amount: refused at the edit and at approval', async () => {
    const reopened = await a.api.reopen(run);
    expect(reopened.statusCode, a.msg(reopened)).toBe(200);
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [run])).rows[0].journal_entry_id);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    // Above the last approved amount (R5 000, approved and paid): refused, nothing written.
    for (const amount of [80_000, 5_000.01]) {
      const up = await patch(run, { employeeId: mid, amount });
      expect(up.statusCode).toBe(409);
      expect(a.msg(up)).toMatch(/can't be raised after the pay date \(last approved R\s5\s000\.00\)\. Pay the difference in a new off-cycle run\./);
    }
    expect((await a.header(run)).status).toBe('calculated');
    // Lower is allowed.
    expect((await patch(run, { employeeId: mid, amount: 4_000 })).statusCode).toBe(200);
    expect((await a.pool.query('SELECT approved_amount::float8 AS x FROM payroll_off_cycle_employees WHERE run_id = $1', [run])).rows[0].x).toBe(5_000);
    // An amount raised another way (below the service, on the draft run) is refused at approval.
    await a.pool.query('UPDATE payroll_off_cycle_employees SET amount = 80000 WHERE run_id = $1', [run]);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    const refused = await a.api.approve(run);
    expect(refused.statusCode).not.toBe(200);
    expect(JSON.stringify(refused.body)).toMatch(/can't be raised after the pay date/);
    expect((await a.header(run)).status).toBe('calculated');
    // Back to R4 000 through the service: approved.
    expect((await patch(run, { employeeId: mid, amount: 4_000 })).statusCode).toBe(200);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    const ok = await a.api.approve(run);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(Number((await a.pool.query('SELECT gross_pay::float8 AS g FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0].g)).toBe(4_000);
  });

  it('the route: a viewer gets 403 on GET and PATCH, a manager 403 on PATCH, an agent bearer 401; nothing read or written', async () => {
    const viewer = await a.addUser('viewer');
    const manager = await a.addUser('manager');
    const amountNow = async () => Number((await a.pool.query('SELECT amount::float8 AS x FROM payroll_off_cycle_employees WHERE run_id = $1', [run])).rows[0].x);
    const before = await amountNow();
    const read = await a.call(amounts as Route, 'GET', `/api/payroll/runs/${run}/off-cycle-amounts`, run, { user: viewer });
    expect(read.statusCode).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain(String(before));
    for (const user of [viewer, manager]) {
      const w = await a.call(amounts as Route, 'PATCH', `/api/payroll/runs/${run}/off-cycle-amounts`, run, { user, body: { employeeId: mid, amount: 1 } });
      expect(w.statusCode).toBe(403);
    }
    // An agent (PAT or OAuth bearer, no session cookie) never reaches it: withAuth reads the cookie session only.
    const req = request({}, 'PATCH', run) as unknown as { headers: Record<string, string>; body: unknown; url: string };
    req.headers.authorization = 'Bearer isf_pat_agent_token';
    req.body = { employeeId: mid, amount: 1 };
    req.url = `/api/payroll/runs/${run}/off-cycle-amounts`;
    const agent = response();
    await (amounts as Route)(req as never, agent.res as never);
    expect(agent.state.statusCode).toBe(401);
    expect(await amountNow()).toBe(before);
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
      .rejects.toThrow(/only a draft bonus run's amount changes/);
    await expect(a.pool.query('UPDATE payroll_off_cycle_employees SET company_id = gen_random_uuid() WHERE run_id = $1', [run]))
      .rejects.toThrow(/only the amount changes/);
    await expect(a.pool.query('UPDATE payroll_off_cycle_employees SET amount = 0 WHERE run_id = $1', [run]))
      .rejects.toThrow(/a bonus amount is more than R0, in whole cents/);
  });
});
