/**
 * Audit 2026-10-18 P3: the round-2 breaker's repros against PR #752 (a864175f7),
 * ported. Each failed there; each now pins the fix. Real routes; disposable DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import componentsRoute from '../../pages/api/payroll/components';
import type { Route } from './w3-01-payroll.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, codes,
  createRunFor, directivePayments, runLine, seedRetrenchedEmployee, SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function component(f: SeveranceFixture, name: string, code: string, amount: number, from: string, to: string, taxable = true) {
  const comp = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, $2, $3, 'earning', $4) RETURNING id`, [f.company, name, code, taxable])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)`, [f.employee, comp, amount, from, to]);
}

describe('REPRO 1: lump-sum code with surrounding whitespace bypasses lump_sum_without_directive', () => {
  it('a tab-padded "3901" is blocked too, and an NBSP-padded one is taxed as periodic pay — never nil PAYE and approvable', async () => {
    const tab = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752b-1 tab code');
    fixtures.push(tab);
    await component(tab, 'Gratuity (tab)', '3901\t', 50_000, '2026-06-01', '2026-06-30');
    const j1 = await createRunFor(tab, 6);
    await calculateRun(tab, j1);
    expect((await runLine(pool, j1, tab.employee)).paye).toBe(SALARY_PAYE);
    expect((await approveRun(tab, j1)).statusCode).toBe(400);

    const nbsp = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752b-1 nbsp code');
    fixtures.push(nbsp);
    await component(nbsp, 'Gratuity (nbsp)', '3901\u00a0', 50_000, '2026-06-01', '2026-06-30');
    const j2 = await createRunFor(nbsp, 6);
    await calculateRun(nbsp, j2);
    expect((await runLine(pool, j2, nbsp.employee)).paye).toBeGreaterThan(SALARY_PAYE);
    expect(codes((await runLine(pool, j2, nbsp.employee)).validation_results)).not.toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
  });

  it('a taxable "3901 " component with no directive is not approvable', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752b-1 code whitespace');
    fixtures.push(f);
    await component(f, 'Gratuity (manual)', '3901 ', 50_000, '2026-06-01', '2026-06-30');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(l.gross).toBe(70_000);
    expect(l.paye).toBe(SALARY_PAYE); // calculator trims → lump sum → nil PAYE
    expect(codes(l.validation_results)).toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
    const approved = await approveRun(f, june);
    expect(approved.statusCode).toBe(400);
  });
});

describe('REPRO 2: non-taxable hand-made 3901 + directive in the same month → paid twice', () => {
  it('June pays the component; July must not pay the directive again', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752b-2 nontaxable same month');
    fixtures.push(f);
    await component(f, 'Severance (captured)', '3901', 30_000, '2026-06-01', '2026-06-30', false);
    await approvedDirective(f, 30_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const jl = await runLine(pool, june, f.employee);
    expect(codes(jl.validation_results)).toContain('SEVERANCE_CAPTURED_AS_COMPONENT');
    // The hand-made 39xx has no directive: approval stays refused until it is removed.
    expect((await approveRun(f, june)).statusCode).toBe(400);
  });
});

describe('REPRO 3: severance paid as a non-taxable 3901 component, directive approved afterwards → paid twice', () => {
  it('the later run does not pay the directive on top of the severance already paid', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752b-3 directive after');
    fixtures.push(f);
    await component(f, 'Severance (captured)', '3901', 30_000, '2026-06-01', '2026-06-30', false);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await runLine(pool, june, f.employee)).gross).toBe(50_000);
    // Since round 2 the gate refuses this line (lump_sum_without_directive). A run approved
    // BEFORE P3 shipped could carry it, so that run's state is set directly: status only.
    expect((await approveRun(f, june)).statusCode).toBe(400);
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [june]);
    const d = await approvedDirective(f, 30_000, 0.1, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    const l = await runLine(pool, july, f.employee);
    expect(l?.gross ?? 0, 'July pays the R30 000 severance again').toBe(0);
    expect(await directivePayments(pool, d)).toEqual([]);
  });
});

describe('REPRO 4: a net-negative 3605 for the year breaks the e@syFile footing', () => {
  it('3601 + 3605 on the certificate equals the gross paid, a clawback and a space-padded code included', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752b-4 negative 3605 filing');
    fixtures.push(f);
    await pool.query(
      `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
         sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
         physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181'
       WHERE id = $1`, [f.company]);
    await component(f, 'Bonus clawback', '3605', -5_000, '2026-06-01', '2026-06-30');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await runLine(pool, june, f.employee)).gross).toBe(15_000);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    // July: a R10 000 bonus whose code was stored with a leading space (before the
    // components route trimmed). The year's 3605 nets to +R5 000.
    await component(f, 'Bonus', ' 3605', 10_000, '2026-07-01', '2026-07-31');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect((await approveRun(f, july)).statusCode).toBe(200);

    const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as {
      url: string; query: Record<string, unknown>;
    };
    req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
    req.query = { taxYear: '2027' };
    const out = response();
    let file = '';
    out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
    await (easyfile as Route)(req as never, out.res as never);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    const fields = file.split(/\r\n/);
    const val = (code: string) => Number((fields.find(x => x.startsWith(`${code},`)) ?? `${code},0`).split(',')[1]);
    const shown = `fields: ${fields.filter(x => /^36/.test(x)).join(' ')}`;
    expect(val('3601') + val('3605'), shown).toBe(45_000);
    expect(val('3605'), shown).toBe(5_000);
    expect(val('3601'), shown).toBe(40_000);
  });
});

describe('round 2 (fix review): a hand-made lump sum on a reopened run whose journal is in force', () => {
  it('counts as paid, so a later directive is not paid on top of it', async () => {
    const { reopenRun } = await import('./p3-severance.helpers');
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK752b-5 reopened in force');
    fixtures.push(f);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    // A pre-P3 run: its posted line carried severance as a hand-made 3901 (no directive).
    await pool.query(
      `UPDATE payroll_run_lines SET component_breakdown = component_breakdown || $2::jsonb WHERE run_id = $1`,
      [june, JSON.stringify([{ componentId: crypto.randomUUID(), componentName: 'Severance (captured)', sarsSourceCode: '3901', amount: 30000, isTaxable: true, isUifApplicable: false }])]);
    expect((await reopenRun(f, june)).statusCode).toBe(200); // 'calculated', journal still in the ledger
    const d = await approvedDirective(f, 30_000, 0.1, '2026-07-02');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect(await runLine(pool, july, f.employee)).toBeUndefined();
    expect(await directivePayments(pool, d)).toEqual([]);
  });
});

describe('round 2 (fix review): the components route', () => {
  it('refuses a SARS code that normalises to nothing', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK752b-6 blank code');
    fixtures.push(f);
    const r = await f.call(componentsRoute as Route, 'POST', '/api/payroll/components', undefined, {
      body: { name: 'Blank', sarsSourceCode: ' \t ', componentType: 'earning' },
    });
    expect(r.statusCode).toBe(400);
    const ok = await f.call(componentsRoute as Route, 'POST', '/api/payroll/components', undefined, {
      body: { name: 'Bonus', sarsSourceCode: ' 3605\t', componentType: 'earning' },
    });
    expect(ok.statusCode).toBe(201);
    expect((await pool.query("SELECT sars_source_code FROM payroll_components WHERE company_id = $1 AND name = 'Bonus'", [f.company])).rows[0]!.sars_source_code).toBe('3605');
  });
});
