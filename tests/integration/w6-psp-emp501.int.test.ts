/**
 * Wave 6 PSP and the EMP501 return (coordinator ruling 2026-11-19): the certificates leave a PSP's lines out (as the
 * e@syFile does) and report the month's PSP apart; a filed EMP201 equal to certificates + PSP is explained_psp, a warning
 * that never blocks finalising; any other gap still refuses. Interim tax year 2026 (Mar-Aug 2025), its own companies.
 */
import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import returns from '../../pages/api/payroll/emp501/returns/index';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import filingFile from '../../pages/api/accounting/sars/returns/[form]/filing-file';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
const PSP_FLAG = [{ code: 'PAYE_OUTSIDE_TABLES', severity: 'warning', treatment: 'flat_psp', psp: { entity: 'company', rate: 0.27 }, message: 'PSP' }];
const fixtures: ReturnFixture[] = [];

async function company(tag: string): Promise<ReturnFixture> {
  assertNotProductionDb('PSP EMP501');
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
async function employee(rf: ReturnFixture, last: string, psp = false): Promise<string> {
  return String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number,
      tax_status, psp_entity_type)
    VALUES (${rf.fx.companyId}::UUID, ${last}, 'Test', ${last}, '2020-01-01', '1980-01-01', '8001015009087', '0123456789',
      ${psp ? 'personal_service_provider' : 'employee'}, ${psp ? 'company' : null})
    RETURNING id`) as Row[])[0]!.id);
}
/** A final March run: Alice on the tables (UIF 354.24), the PSP at 27% of 40 000 (no UIF), SDL 1% each; header = lines. */
async function marchRun(rf: ReturnFixture, alice: string, psp: string): Promise<void> {
  const id = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif, total_sdl, employee_count,
      approved_at, run_kind, period_start, period_end)
    VALUES (${rf.fx.companyId}::UUID, 2025, 3, 'approved', 70000, 14800, 354.24, 700, 2, '2025-04-01T10:00:00Z', 'regular', '2025-03-01', '2025-03-31')
    RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
    VALUES (${id}::UUID, ${alice}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown, validation_results)
    VALUES (${id}::UUID, ${psp}::UUID, 40000, 40000, 10800, 0, 0, 400, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 40000 }])}::JSONB,
      ${JSON.stringify(PSP_FLAG)}::JSONB)`;
}
async function fileEmp201(rf: ReturnFixture, month: number): Promise<void> {
  const mm = String(month).padStart(2, '0');
  const end = new Date(Date.UTC(2025, month, 0)).toISOString().slice(0, 10);
  const f = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: `2025-${mm}-01`, periodEnd: end });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const v = (f.body as { data: { version: Row } }).data.version;
  expect((await callRoute(filingFile, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, format: 'csv' })).status).toBe(200);
  const r = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, reference: `7123456789L000000${mm}` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
/** A directive paid outside payroll in March naming no employee: on the EMP201, on no certificate (an unexplained gap). */
async function noEmployeeDirective(rf: ReturnFixture, paye: number): Promise<void> {
  const c = rf.fx.companyId;
  const d = String(((await sql`INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, directive_number, amount, effective_date, issued_date, status)
    VALUES (${c}::UUID, NULL, 'Former Person', 'severance', '123456789012', 100000, '2025-03-10', '2025-03-10', 'active') RETURNING id`) as Row[])[0]!.id);
  const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, description, entry_number)
    VALUES (${c}::UUID, '2025-03-10', ${rf.admin.userId}, 'posted', 'Severance', ${`JE-PSP-${randomUUID().slice(0, 6)}`}) RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
    VALUES (${c}::UUID, ${d}::UUID, '2025-03-10', 100000, ${paye}, ${100000 - paye}, ${je}::UUID)`;
}
const readiness = async (rf: ReturnFixture) =>
  ((await callRoute(returns, rf.fx.companyId, rf.admin.token, 'GET', INTERIM)).body as { data: { readiness: Row } }).data.readiness;
const finaliseEmp501 = (rf: ReturnFixture) => callRoute(returns, rf.fx.companyId, rf.admin.token, 'POST', {}, { action: 'finalise', ...INTERIM });

describeIfDb('wave 6 PSP: the EMP501 return', () => {
  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM tax_directive_payments WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM tax_directives WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID AND entry_number LIKE 'JE-PSP-%'`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf).catch(() => undefined);
    }
  }, 120000);

  it('a PSP company\'s interim: the gap is exactly PSP, explained_psp warns, and it finalises', async () => {
    const rf = await company('PSP-EXPLAINED');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true));
    await fileEmp201(rf, 3); // declares 14 800 PAYE: Alice's 4 000 + the PSP's 10 800
    const g = await readiness(rf);
    expect(g.emp201Mismatches).toEqual([]);
    expect(g.emp201ExplainedByPsp).toEqual(['March 2025: explained by PSP PAYE 10800.00 (PSP-H pending)']);
    expect((g.warnings as string[]).some((w) => w.includes('explained by PSP'))).toBe(true);
    expect(g.ready).toBe(true);
    const r = await finaliseEmp501(rf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('PSP plus an unexplained gap in the same month: still a mismatch, and finalising refuses', async () => {
    const rf = await company('PSP-UNEXPLAINED');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true));
    await noEmployeeDirective(rf, 5_000);
    await fileEmp201(rf, 3); // declares 19 800: Alice 4 000 + PSP 10 800 + 5 000 on no certificate
    const g = await readiness(rf);
    expect(g.emp201ExplainedByPsp).toEqual([]);
    expect(g.ready).toBe(false);
    const r = await finaliseEmp501(rf);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('EMP501_NOT_READY');
  });
});
