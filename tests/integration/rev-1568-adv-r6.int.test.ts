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
import legacyEmp201 from '../../pages/api/accounting/sars/sars-emp201';
import legacySubs from '../../pages/api/accounting/sars/sars-submissions';

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

/** Save and mark submitted an EMP201 through the LEGACY routes (any period the user types), as a user can today. */
async function legacyEmp201ViaRoutes(rf: ReturnFixture, periodStart: string, periodEnd: string): Promise<void> {
  const s = await callRoute(legacyEmp201, rf.fx.companyId, rf.admin.token, 'POST', {}, { periodStart, periodEnd });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const id = (s.body as { data: { id: string } }).data.id;
  const m = await callRoute(legacySubs, rf.fx.companyId, rf.admin.token, 'POST', {}, { id, action: 'mark_submitted', reference: 'LEGACY-2M' });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
}

async function febRun(rf: ReturnFixture, emp: string, paye: number): Promise<string> {
  const id = String(((await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, total_uif, total_sdl,
      approved_at, run_kind, period_start, period_end)
    VALUES (${rf.fx.companyId}::UUID, 2025, 2, 'approved', 30000, ${paye}, 354.24, 300, '2025-03-01T10:00:00Z', 'regular', '2025-02-01', '2025-02-28')
    RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
    VALUES (${id}::UUID, ${emp}::UUID, 30000, 30000, ${paye}, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
  return id;
}

describeIfDb('PR #1568 round 6 adversarial: overlap outside the return', () => {
  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf).catch(() => undefined);
    }
  }, 120000);

  it('G4: Feb-Mar legacy EMP201 (8000); Feb corrected to 2000 and Mar to 6000; a newer Feb-only legacy EMP201 (2000) shadows its February: the overlap is outside the return, so no conflict, and March (understated by 2000) passes', async () => {
    const rf = await company('G4');
    const alice = await employee(rf, 'Alice');
    const feb = await febRun(rf, alice, 4000);
    const mar = await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyEmp201ViaRoutes(rf, '2025-02-01', '2025-03-31');
    await sql`UPDATE payroll_run_lines SET paye = 2000 WHERE run_id = ${feb}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 2000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${feb}::UUID`;
    await sql`UPDATE payroll_run_lines SET paye = 6000 WHERE run_id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 6000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${mar}::UUID`;
    await legacyEmp201ViaRoutes(rf, '2025-02-01', '2025-02-28');
    const subs = await sql`SELECT period_start::TEXT AS s, period_end::TEXT AS e, form_data->>'totalPAYE' AS paye FROM sars_submissions
      WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP201' ORDER BY submitted_at`;
    const g = await readiness(rf);
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('G4', JSON.stringify(subs), JSON.stringify(g), r.status);
    expect(r.status).toBe(409);
    expect(g.emp201Conflicts).toEqual(['February 2025 (reference LEGACY-2M) and February 2025 to March 2025 (reference LEGACY-2M) both file February 2025']);
    expect(JSON.stringify(r.body)).toContain('both file February 2025: file those months through the return lifecycle');
  });

  it('G5 (control): an accepted legacy row and a submitted one for the same month conflict; a cancelled/rejected one does not', async () => {
    const rf = await company('G5');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    const ins = (status: string, ref: string) => sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
      VALUES (${rf.fx.companyId}::UUID, 'EMP201', '2025-03-01', '2025-03-31', ${status}, ${ref}, now(), ${JSON.stringify({ totalPAYE: 4000, totalUIF: 354.24, totalSDL: 300 })}::JSONB)`;
    await ins('submitted', 'S1');
    await ins('rejected', 'R1');
    expect(await readiness(rf)).toMatchObject({ emp201Conflicts: [], ready: true });
    await ins('accepted', 'A1');
    expect((await readiness(rf)).emp201Conflicts).toHaveLength(1);
  });

  // EFb's round-6 addition: the remedy. Filing March through the lifecycle supersedes the Feb-Mar row (A); the Feb-only
  // row no longer reaches the return, so nothing conflicts and the EMP501 finalises on the March version.
  it('G6: filing March through the return lifecycle (correcting the Feb-Mar row) clears the conflict outside the return', async () => {
    const rf = await company('G6');
    const alice = await employee(rf, 'Alice');
    const feb = await febRun(rf, alice, 4000);
    const mar = await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await legacyEmp201ViaRoutes(rf, '2025-02-01', '2025-03-31');
    await sql`UPDATE payroll_run_lines SET paye = 2000 WHERE run_id = ${feb}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 2000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${feb}::UUID`;
    await sql`UPDATE payroll_run_lines SET paye = 6000 WHERE run_id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 6000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${mar}::UUID`;
    await legacyEmp201ViaRoutes(rf, '2025-02-01', '2025-02-28');
    expect((await readiness(rf)).emp201Conflicts).toHaveLength(1);
    const f = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: '2025-03-01', periodEnd: '2025-03-31' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const v = (f.body as { data: { version: Row } }).data.version;
    expect((await callRoute(filingFile, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, format: 'csv' })).status).toBe(200);
    const body = { versionId: v.id, reference: '7123456789L00000003' };
    const first = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, body);
    expect(first.status).toBe(409); // LEGACY_SUBMISSION_EXISTS names the Feb-Mar row
    const ids = (first.body as { error: { details: { legacySubmissionIds: string[] } } }).error.details.legacySubmissionIds;
    expect(ids).toHaveLength(1);
    const r = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' },
      { ...body, correctsLegacySubmissionIds: ids, reason: 'Filed again through the return lifecycle' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await sql`SELECT status FROM sars_submissions WHERE id = ${ids[0]!}::UUID`).toEqual([{ status: 'superseded' }]);
    expect(await readiness(rf)).toMatchObject({ emp201Conflicts: [], unfiledEmp201Months: [], emp201Mismatches: [], ready: true });
    const e = await finaliseEmp501(rf);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(((await emp501Versions(rf))[0]!.figures as { totals: Row }).totals).toMatchObject({ paye: 6000 });
  });

  // EFb's round-6 addition: a lifecycle EMP201 version outside the return that a legacy row reaching into it also files.
  it('G7: February filed through the return lifecycle and a Feb-Mar legacy EMP201 row (not through the routes, which refuse it): February is filed twice, a conflict', async () => {
    const rf = await company('G7');
    const alice = await employee(rf, 'Alice');
    await febRun(rf, alice, 4000);
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    await fileEmp201(rf, 2);
    // The legacy routes refuse a period that has a return version (409), so the row is written as an import would.
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
      VALUES (${rf.fx.companyId}::UUID, 'EMP201', '2025-02-01', '2025-03-31', 'submitted', 'LEGACY-2M', now(),
        ${JSON.stringify({ totalPAYE: 8000, totalUIF: 708.48, totalSDL: 600 })}::JSONB)`;
    const g = await readiness(rf);
    expect(g.emp201Conflicts).toEqual([
      'February 2025 to March 2025 (reference LEGACY-2M) and the return-lifecycle EMP201 version 1 (filed) both file February 2025']);
    expect((await finaliseEmp501(rf)).status).toBe(409);
  });
});
