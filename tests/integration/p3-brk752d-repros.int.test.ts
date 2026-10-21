/**
 * Audit 2026-10-18 P3: the round-4 breaker's probes against PR #752 (2ccb3ab09),
 * ported. Both passed there; each pins a behaviour a later change could break.
 * Real routes; disposable DB.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, directivePayments,
  previewRun, reopenRun, runLine, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
afterAll(async () => { try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); } });

describe('P3: a leaver from an earlier period whose directive is unpayable', () => {
  it('gets no line, approval is not blocked, and the preview names the reason', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'P3 brk752d unpayable leaver');
    fixtures.push(f);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    const d = await approvedDirective(f, 30_000, 1.5, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect(await runLine(pool, july, f.employee)).toBeUndefined();
    const adv = (await previewRun(f, july)).body.data?.plan?.advisories as Array<{ code: string; detail: string }>;
    expect(adv.find(a => a.code === 'severance_directive_not_paid')?.detail).toMatch(/below nil or above the gross/);
    expect(await directivePayments(pool, d)).toEqual([]);
  });
});

describe('P3: a hand-made 3901 in a reopened run with no journal in force', () => {
  it('does not stand in for severance: the directive is paid', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'P3 brk752d reopened hand-made');
    fixtures.push(f);
    const comp = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Severance (pre-P3)', '3901', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 30000, '2026-06-01', '2026-06-30')`, [f.employee, comp]);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    // Approved without a journal (status only), then reopened: nothing of June is in the ledger.
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [june]);
    expect((await reopenRun(f, june)).statusCode).toBe(200);
    await approvedDirective(f, 30_000, 0.1, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect((await runLine(pool, july, f.employee))?.gross).toBe(30_000);
  });
});
