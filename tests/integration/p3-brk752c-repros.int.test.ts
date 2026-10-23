/**
 * Audit 2026-10-18 P3: the round-3 breaker's repros against PR #752 (5e30fff21),
 * ported. Each failed there; each now pins the fix. Real routes; disposable DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import type { Route } from './w3-01-payroll.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures,
  createRunFor, directivePayments, previewRun, runLine, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); } });

async function component(f: SeveranceFixture, name: string, code: string, amount: number, from: string, to: string, taxable = true) {
  const comp = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, $2, $3, 'earning', $4) RETURNING id`, [f.company, name, code, taxable])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)`, [f.employee, comp, amount, from, to]);
}

describe('REPRO 5: an earlier hand-made lump sum and a later severance directive', () => {
  it('a leaver paid a R2 000 3920 lump sum before P3 is still paid the R30 000 severance on the directive', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752c-5 unrelated lump sum');
    fixtures.push(f);
    await component(f, 'Retirement fund lump sum (pre-P3)', '3920', 2_000, '2026-05-01', '2026-05-31');
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [may]); // approved before P3
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200); // final month: salary, severance awaits directive
    const d = await approvedDirective(f, 30_000, 0.1, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    const l = await runLine(pool, july, f.employee);
    expect(l?.gross).toBe(30_000); // 3920 is a retirement lump sum, not severance (3901)
    expect((await approveRun(f, july)).statusCode).toBe(200);
    expect(await directivePayments(pool, d)).toHaveLength(1);
  });

  it('a partial hand-made 3901 (R10 000 of a R30 000 directive): nothing more is paid, and the approval preview says why', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752c-5b partial');
    fixtures.push(f);
    await component(f, 'Severance part (pre-P3)', '3901', 10_000, '2026-06-01', '2026-06-30');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [june]);
    await approvedDirective(f, 30_000, 0.1, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect(await runLine(pool, july, f.employee)).toBeUndefined();
    const advisories = (await previewRun(f, july)).body.data?.plan?.advisories as Array<{ code: string; detail: string }>;
    const note = advisories.find(a => a.code === 'severance_directive_not_paid');
    expect(note?.detail).toMatch(/W301-1.*already paid by hand in the 2026-06 run/);
  });
});

describe('round 3 (fix review): a hand-made lump sum other than severance beside a directive in the final month', () => {
  it('does not hold the directive back: the severance is on the line, and the run waits only on the other lump sum', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752c-6 3920 beside directive');
    fixtures.push(f);
    await component(f, 'Retirement lump sum (manual)', '3920', 2_000, '2026-06-01', '2026-06-30');
    await approvedDirective(f, 30_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(l.gross).toBe(52_000);
    const codesOn = (l.validation_results as Array<{ code: string }>).map(v => v.code);
    expect(codesOn).toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
    expect(codesOn).not.toContain('SEVERANCE_CAPTURED_AS_COMPONENT');
    expect((await previewRun(f, june)).body.data?.blocker?.code).toBe('lump_sum_without_directive');
  });
});

describe('REPRO 4 (original, kept): a year whose only 3605 is a clawback', () => {
  it('3601 + 3605 equals the gross paid', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752c-4 negative 3605 only');
    fixtures.push(f);
    await pool.query(
      `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
         sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
         physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181'
       WHERE id = $1`, [f.company]);
    await component(f, 'Bonus clawback', '3605', -5_000, '2026-06-01', '2026-06-30');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
    req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
    req.query = { taxYear: '2027' };
    const out = response();
    let file = '';
    out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
    await (easyfile as Route)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(200);
    const fields = file.split(/\r\n/);
    const val = (code: string) => Number((fields.find(x => x.startsWith(`${code},`)) ?? `${code},0`).split(',')[1]);
    expect(val('3601') + val('3605')).toBe(15_000);
  });
});
