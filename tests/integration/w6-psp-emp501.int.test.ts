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
import { emp501FileOf } from '../../src/modules/accounting/services/returns/emp501FilingFile';

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
/** `particulars` (wave 6 PSP-H): the entity's trading name, registration number and tax reference, so its H certificate is filed. */
async function employee(rf: ReturnFixture, last: string, psp = false, particulars = false): Promise<string> {
  const p = psp && particulars;
  return String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number,
      tax_status, psp_entity_type, psp_entity_name, psp_registration_number, psp_tax_reference)
    VALUES (${rf.fx.companyId}::UUID, ${last}, 'Test', ${last}, '2020-01-01', '1980-01-01', '8001015009087', '0123456789',
      ${psp ? 'personal_service_provider' : 'employee'}, ${psp ? 'company' : null},
      ${p ? 'Pspco Consulting (Pty) Ltd' : null}, ${p ? '2015/123456/07' : null}, ${p ? '9012345675' : null})
    RETURNING id`) as Row[])[0]!.id);
}
/** A final March run: Alice on the tables (UIF 354.24), the PSP at 27% of 40 000 (no UIF), SDL 1% each; header = lines. */
async function marchRun(rf: ReturnFixture, alice: string, psp: string, pspPaye = 10_800, pspSdl = 400): Promise<void> {
  const id = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif, total_sdl, employee_count,
      approved_at, run_kind, period_start, period_end)
    VALUES (${rf.fx.companyId}::UUID, 2025, 3, 'approved', 70000, ${4000 + pspPaye}, 354.24, ${300 + pspSdl}, 2, '2025-04-01T10:00:00Z', 'regular', '2025-03-01', '2025-03-31')
    RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
    VALUES (${id}::UUID, ${alice}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown, validation_results)
    VALUES (${id}::UUID, ${psp}::UUID, 40000, 40000, ${pspPaye}, 0, 0, ${pspSdl}, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 40000 }])}::JSONB,
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
/** A legacy EMP201 (sars_submissions) for March with stored totals. */
const legacyMarch = (rf: ReturnFixture, paye: number, sdl: number, ref: string) => sql`
  INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
  VALUES (${rf.fx.companyId}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', ${ref}, now(),
    ${JSON.stringify({ totalPAYE: paye, totalUIF: 354.24, totalSDL: sdl })}::JSONB)`;
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
    expect(g.emp201ExplainedByPsp).toEqual(['March 2025: explained by PSP PAYE 10800.00 and SDL 400.00 (on no certificate: a PSP without its entity particulars or with no PAYE)']);
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

  it('A (review L3): PSP PAYE nil, PSP SDL 400, lifecycle EMP201: finalises, and the SDL-only explanation is named', async () => {
    const rf = await company('PSP-A');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true), 0, 400);
    await fileEmp201(rf, 3);
    const g = await readiness(rf);
    expect(g.emp201ExplainedByPsp).toEqual(['March 2025: explained by PSP SDL 400.00 (on no certificate: a PSP without its entity particulars or with no PAYE)']);
    expect((await finaliseEmp501(rf)).status).toBe(200);
  });

  it('B (review L3): a legacy EMP201 whose stored totals are certificates + PSP: finalises, and the row is named', async () => {
    const rf = await company('PSP-B');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true));
    await legacyMarch(rf, 14_800, 700, 'L-B');
    const g = await readiness(rf);
    expect(g.emp201ExplainedByPsp).toEqual(['March 2025 (reference L-B): explained by PSP PAYE 10800.00 and SDL 400.00 (on no certificate: a PSP without its entity particulars or with no PAYE)']);
    expect((await finaliseEmp501(rf)).status).toBe(200);
  });

  it('PSP-H: with its particulars the PSP is on its own H certificate: no explained_psp, totals include it, the file carries it', async () => {
    const rf = await company('PSP-H');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true, true));
    await fileEmp201(rf, 3); // 14 800 PAYE: now all of it on certificates
    const g = await readiness(rf);
    expect([g.emp201Mismatches, g.emp201ExplainedByPsp, g.ready]).toEqual([[], [], true]);
    const r = await finaliseEmp501(rf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = String(((r.body as { data: { version: Row } }).data.version).id);
    const v = ((await sql`SELECT form_type, figures FROM tax_return_versions WHERE id = ${id}::UUID AND company_id = ${rf.fx.companyId}::UUID`) as Row[])[0]!;
    const f = v.figures as { totals: Row; warnings: string[]; certificateEmployees: Row[] };
    expect(f.totals).toMatchObject({ certificates: 2, paye: 14800, sdl: 700 });
    expect(f.warnings.some((w) => w.includes('personal service provider'))).toBe(false); // the e@syFile file names only the uncertified
    expect(f.certificateEmployees).toHaveLength(1); // the H certificate is the entity's: never in the employee portal's map
    const lines = emp501FileOf({ formType: 'EMP501', figures: v.figures as Record<string, unknown> }).body.split('\r\n');
    const h = lines.slice(lines.indexOf('3020,"H"') - 2, lines.indexOf('4142,400.00') + 1);
    expect(h).toEqual(['3010,"712345678920260800000000000002"', '3015,"IRP5"', '3020,"H"', '3025,2026', '3030,"Pspco Consulting (Pty) Ltd"',
      '3065,1', '3066,"2015/123456/07"', '3100,9012345675', '3170,20250301', '3180,20250331', '3200,12.0000', '3210,1.0000',
      '3601,40000', '4102,10800.00', '4141,0.00', '4142,400.00']);
    expect(lines).toContain('6010,3');
  });

  it('PSP-H ruling 2026-11-20: a PSP with particulars but no PAYE is on no certificate, named, and the file still exports', async () => {
    const rf = await company('PSP-H-NOPAYE');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true, true), 0, 400);
    await fileEmp201(rf, 3);
    const g = await readiness(rf);
    expect(g.emp201ExplainedByPsp).toEqual(['March 2025: explained by PSP SDL 400.00 (on no certificate: a PSP without its entity particulars or with no PAYE)']);
    const r = await finaliseEmp501(rf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = String(((r.body as { data: { version: Row } }).data.version).id);
    const v = ((await sql`SELECT figures FROM tax_return_versions WHERE id = ${id}::UUID AND company_id = ${rf.fx.companyId}::UUID`) as Row[])[0]!;
    const f = v.figures as { totals: Row; warnings: string[] };
    expect(f.totals).toMatchObject({ certificates: 1, paye: 4000, sdl: 300 });
    expect(f.warnings.some((w) => w.includes('Pspco') && w.includes('no PAYE was deducted on it'))).toBe(true);
    const body = emp501FileOf({ formType: 'EMP501', figures: v.figures as Record<string, unknown> }).body;
    expect(body).not.toContain('3020,"H"');
    expect(body).toContain('6010,2');
  });

  it('L3 (review of #1689): a stored tax reference failing modulus 10 (direct SQL) is uncertified, a named readiness error, and finalise agrees', async () => {
    const rf = await company('PSP-H-MOD10');
    const psp = await employee(rf, 'Pspco', true, true);
    await sql`UPDATE payroll_employees SET psp_tax_reference = '9012345678' WHERE id = ${psp}::UUID AND company_id = ${rf.fx.companyId}::UUID`;
    await marchRun(rf, await employee(rf, 'Alice'), psp);
    await fileEmp201(rf, 3);
    const g = await readiness(rf);
    expect(g.pspParticularsErrors).toEqual(['Test Pspco (Pspco): the PSP certificate cannot be filed, as its income tax reference (code 3100) is not 10 digits starting with 9 that pass the SARS modulus 10 test; correct it on the Work card']);
    expect(g.emp201ExplainedByPsp).toHaveLength(1); // counted apart, as uncertified
    expect([g.emp201Mismatches, g.ready]).toEqual([[], false]);
    const r = await finaliseEmp501(rf);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('modulus 10');
  });

  it('C (review L4): a legacy EMP201 that left the PSP out refuses, and the message says the figure is certificates plus PSP', async () => {
    const rf = await company('PSP-C');
    await marchRun(rf, await employee(rf, 'Alice'), await employee(rf, 'Pspco', true));
    await legacyMarch(rf, 4_000, 300, 'L-C');
    const g = await readiness(rf);
    expect(g.ready).toBe(false);
    expect(g.emp201Mismatches).toEqual(['March 2025 (reference L-C): PAYE 4000.00 filed, 14800.00 on the certificates, SDL 300.00 filed, 700.00 on the certificates (certificates plus PSP lines)']);
    expect((await finaliseEmp501(rf)).status).toBe(409);
  });
});
