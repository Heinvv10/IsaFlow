/**
 * Adversarial repros for PR #1568 (EMP501 lifecycle). Each `it` asserts what a correct EMP501 must do; a red test is a
 * confirmed break. Every scenario gets its own company (seedReturnFixture), interim tax year 2026 (Mar-Aug 2025).
 */
import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, loginAsToken, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import returns from '../../pages/api/payroll/emp501/returns/index';
import emp501File from '../../pages/api/payroll/emp501/returns/filing-file';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import filingFile from '../../pages/api/accounting/sars/returns/[form]/filing-file';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
const fixtures: ReturnFixture[] = [];

async function company(tag: string): Promise<ReturnFixture> {
  assertNotProductionDb('adversarial EMP501 repro');
  const rf = await seedReturnFixture(tag, DATABASE_URL!);
  fixtures.push(rf);
  await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
    VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING`;
  refreshCache();
  await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
    sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
    physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = ${rf.fx.companyId}::UUID`;
  return rf;
}
async function employee(rf: ReturnFixture, last: string): Promise<string> {
  return String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
    VALUES (${rf.fx.companyId}::UUID, ${last}, 'Test', ${last}, '2020-01-01', '1980-01-01', '8001015009087', '0123456789')
    RETURNING id`) as Row[])[0]!.id);
}
async function run(rf: ReturnFixture, month: number, lines: Array<[string, number, number]>,
  opts: { status?: string; approved?: boolean; kind?: 'regular' | 'off_cycle' } = {}): Promise<string> {
  const kind = opts.kind ?? 'regular';
  const id = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, approved_at, run_kind, off_cycle_reason,
      period_start, period_end)
    VALUES (${rf.fx.companyId}::UUID, 2025, ${month}, ${opts.status ?? 'approved'}, ${lines.reduce((t, l) => t + l[1], 0)},
      ${lines.reduce((t, l) => t + l[2], 0)}, ${opts.approved === false ? null : '2025-04-01T10:00:00Z'}, ${kind},
      ${kind === 'off_cycle' ? 'bonus' : null}, make_date(2025, ${month}, 1), (make_date(2025, ${month}, 1) + INTERVAL '1 month - 1 day')::DATE)
    RETURNING id`) as Row[])[0]!.id);
  for (const [emp, gross, paye] of lines) {
    await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
      VALUES (${id}::UUID, ${emp}::UUID, ${gross}, ${gross}, ${paye}, 177.12, 177.12, ${gross / 100},
        ${JSON.stringify([{ sarsSourceCode: '3601', amount: gross }])}::JSONB)`;
  }
  return id;
}
/** File the month's EMP201 through the real lifecycle routes (finalise, download the file, mark filed). */
async function fileEmp201(rf: ReturnFixture, month: number): Promise<Row> {
  const mm = String(month).padStart(2, '0');
  const end = new Date(Date.UTC(2025, month, 0)).toISOString().slice(0, 10);
  const f = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: `2025-${mm}-01`, periodEnd: end });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const v = (f.body as { data: { version: Row } }).data.version;
  expect((await callRoute(filingFile, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, format: 'csv' })).status).toBe(200);
  const r = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' },
    { versionId: v.id, reference: `7123456789L000000${String(month).padStart(2, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ((await sql`SELECT figures FROM tax_return_versions WHERE id = ${String(v.id)}::UUID`) as Row[])[0]!.figures as Row;
}
const finaliseEmp501 = (rf: ReturnFixture, token = rf.admin.token) =>
  callRoute(returns, rf.fx.companyId, token, 'POST', {}, { action: 'finalise', ...INTERIM });
const emp501Versions = async (rf: ReturnFixture) =>
  (await sql`SELECT * FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP501' ORDER BY version_no`) as Row[];
const legacyFiled = (rf: ReturnFixture, month: number) => sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
  VALUES (${rf.fx.companyId}::UUID, 'EMP201', make_date(2025, ${month}, 1), (make_date(2025, ${month}, 1) + INTERVAL '1 month - 1 day')::DATE,
    'submitted', ${`LEGACY-${month}`}, now())`;


/** A final monthly run whose header totals equal its lines (UIF 177.12 + 177.12 per line, SDL 1% of gross). */
async function run2(rf: ReturnFixture, month: number, lines: Array<[string, number, number]>): Promise<string> {
  const id = await run(rf, month, lines);
  await sql`UPDATE payroll_run_headers SET total_uif = ${lines.length * 354.24}, total_sdl = ${lines.reduce((t, l) => t + l[1] / 100, 0)},
    employee_count = ${lines.length} WHERE id = ${id}::UUID`;
  return id;
}
async function standalone(rf: ReturnFixture, employeeId: string | null, day: string, paye: number): Promise<void> {
  const c = rf.fx.companyId;
  const d = String(((await sql`INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, directive_number, amount, effective_date, issued_date, status)
    VALUES (${c}::UUID, ${employeeId}::UUID, 'Former Person', 'severance', '123456789012', 100000, ${day}::DATE, ${day}::DATE, 'active') RETURNING id`) as Row[])[0]!.id);
  const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, description, entry_number)
    VALUES (${c}::UUID, ${day}::DATE, ${rf.admin.userId}, 'posted', 'Severance', ${`JE-B3-${randomUUID().slice(0, 6)}`}) RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
    VALUES (${c}::UUID, ${d}::UUID, ${day}::DATE, 100000, ${paye}, ${100000 - paye}, ${je}::UUID)`;
}
const readiness = async (rf: ReturnFixture) =>
  ((await callRoute(returns, rf.fx.companyId, rf.admin.token, 'GET', INTERIM)).body as { data: { readiness: Row } }).data.readiness;
const filedEmp201Paye = async (rf: ReturnFixture) => Number(((await sql`SELECT COALESCE(SUM((figures->>'totalPAYE')::numeric), 0) AS n
  FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP201' AND status = 'filed'`) as Row[])[0]!.n);

describeIfDb('PR #1568 round 2 adversarial', () => {
  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM tax_directive_payments WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM tax_directives WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID AND entry_number LIKE 'JE-B3-%'`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf).catch(() => undefined);
    }
  }, 120000);

  it('D1: a legacy-filed EMP201 whose saved totals (PAYE 4000) disagree with the certificates (9000) is never compared', async () => {
    const rf = await company('D1');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 9_000]]);
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
      VALUES (${rf.fx.companyId}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', 'LEGACY-3', now(),
        ${JSON.stringify({ totalPAYE: 4000, totalUIF: 354.24, totalSDL: 300 })}::JSONB)`;
    const g = await readiness(rf);
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('D1', JSON.stringify(g), r.status);
    expect(r.status).toBe(409);
  });

  it('D2: a lump sum whose directive names no employee: on the filed June EMP201 (18000) and in the per-month match, but on no certificate', async () => {
    const rf = await company('D2');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 3);
    await standalone(rf, null, '2025-06-10', 18_000);
    await fileEmp201(rf, 6);
    const g = await readiness(rf);
    const r = await finaliseEmp501(rf);
    const v = (await emp501Versions(rf))[0];
    // eslint-disable-next-line no-console
    console.log('D2', JSON.stringify(g), r.status, 'filed EMP201 PAYE', await filedEmp201Paye(rf), 'EMP501 totals', JSON.stringify((v?.figures as Row | undefined)?.totals));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/PAYE 22000\.00 on the filed EMP201s, 4000\.00 on the certificates/);
    expect(v).toBeUndefined();
  });

  it('D3: the March run, refused by its EMP201 check after the employee moved to weekly pay, refuses naming the March EMP201 check', async () => {
    const rf = await company('D3');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 3);
    await sql`UPDATE payroll_employees SET pay_frequency = 'weekly' WHERE id = ${alice}::UUID`;
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('D3', r.status, JSON.stringify(r.body).slice(0, 400));
    // Ruling L (round 2): the refusal stands (no logic change); it names the month whose EMP201 check refused the run.
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("EMP501 can't be finalised: the March 2025 EMP201 check refused this run");
    expect(await emp501Versions(rf)).toHaveLength(0);
  });

  // EFb's round-2 additions.
  it('D1b: a legacy EMP201 with no stored totals is not compared: a named warning, and the finalise goes ahead', async () => {
    const rf = await company('D1B');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyFiled(rf, 3);
    const g = await readiness(rf);
    expect(g.warnings).toEqual(['EMP201 for March 2025 was filed before figures were stored (no stored totals); not cross-checked']);
    expect(g).toMatchObject({ ready: true, emp201Mismatches: [] });
    expect((await finaliseEmp501(rf)).status).toBe(200);
  });

  it('D1c: a legacy EMP201 whose stored totals equal the certificates finalises, cross-checked', async () => {
    const rf = await company('D1C');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
      VALUES (${rf.fx.companyId}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', 'LEGACY-3', now(),
        ${JSON.stringify({ totalPAYE: 4000, totalUIF: 354.24, totalSDL: 300 })}::JSONB)`;
    expect(await readiness(rf)).toMatchObject({ ready: true, warnings: [] });
    expect((await finaliseEmp501(rf)).status).toBe(200);
  });

  it('D2b: an employee with no certificate (income under R1) whose UIF is on the filed EMP201: the period check refuses naming UIF', async () => {
    const rf = await company('D2B');
    const alice = await employee(rf, 'Alice');
    const nil = await employee(rf, 'Nil');
    const runId = await run2(rf, 3, [[alice, 30_000, 4_000], [nil, 0, 0]]);
    await sql`UPDATE payroll_run_lines SET component_breakdown = '[]'::JSONB WHERE run_id = ${runId}::UUID AND employee_id = ${nil}::UUID`;
    await fileEmp201(rf, 3);
    const r = await finaliseEmp501(rf);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/UIF 708\.48 on the filed EMP201s, 354\.24 on the certificates/);
    expect(await emp501Versions(rf)).toHaveLength(0);
  });

  it('D2c: a lump sum to no employee in a month with a run: the month\'s match names the PAYE no certificate carries', async () => {
    const rf = await company('D2C');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await standalone(rf, null, '2025-03-20', 18_000);
    await fileEmp201(rf, 3); // declares 4000 + 18000
    expect((await readiness(rf)).emp201Mismatches).toEqual(['March 2025: PAYE 22000.00 filed, 4000.00 on the certificates']);
  });

  it('D4 (control): EMP201 v1 filed, payroll corrected, amended, v2 finalised and filed: the EMP501 finalises with the corrected totals', async () => {
    const rf = await company('D4');
    const alice = await employee(rf, 'Alice');
    const runId = await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 3);
    await sql`UPDATE payroll_run_lines SET paye = 9000 WHERE run_id = ${runId}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 9000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${runId}::UUID`;
    const v1 = ((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP201'`) as Row[])[0]!.id;
    expect((await callRoute(amend, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v1, reason: 'PAYE corrected' })).status).toBe(200);
    expect((await finaliseEmp501(rf)).status).toBe(409); // amend not yet filed
    await fileEmp201(rf, 3);
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('D4', r.status, JSON.stringify(r.body).slice(0, 300));
    expect(r.status).toBe(200);
    expect(((await emp501Versions(rf))[0]!.figures as { totals: Row }).totals).toMatchObject({ paye: 9000 });
  });

  it('D5 (control): an approved monthly regular run of a monthly employee passes the run-kind guard; the PR suites already cover it, this pins it with header totals equal to the lines', async () => {
    const rf = await company('D5');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 3);
    const r = await finaliseEmp501(rf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});
