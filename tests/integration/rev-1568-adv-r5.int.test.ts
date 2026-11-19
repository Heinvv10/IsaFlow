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

describeIfDb('PR #1568 round 5 adversarial: overlapping legacy rows', () => {
  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf).catch(() => undefined);
    }
  }, 120000);

  it('G1: Mar-Apr legacy EMP201 (8000), then March and April corrected in opposite directions (6000 / 2000), then a newer April-only legacy EMP201 (2000): March is understated by 2000 and nothing says so', async () => {
    const rf = await company('G1');
    const alice = await employee(rf, 'Alice');
    const mar = await run2(rf, 3, [[alice, 30_000, 4_000]]);
    const apr = await run2(rf, 4, [[alice, 30_000, 4_000]]);
    await legacyEmp201ViaRoutes(rf, '2025-03-01', '2025-04-30');
    await sql`UPDATE payroll_run_lines SET paye = 6000 WHERE run_id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 6000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_lines SET paye = 2000 WHERE run_id = ${apr}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 2000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${apr}::UUID`;
    await legacyEmp201ViaRoutes(rf, '2025-04-01', '2025-04-30');
    const subs = await sql`SELECT period_start::TEXT AS s, period_end::TEXT AS e, form_data->>'totalPAYE' AS paye FROM sars_submissions
      WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP201' ORDER BY submitted_at`;
    const g = await readiness(rf);
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('G1', JSON.stringify(subs), JSON.stringify(g), r.status);
    expect(r.status).toBe(409);
    // Ruling (round 5): a month two legacy rows file is a conflict, named with both rows.
    expect(g.emp201Conflicts).toEqual([
      'March 2025 to April 2025 (reference LEGACY-2M) and April 2025 (reference LEGACY-2M) both file April 2025']);
    expect(JSON.stringify(r.body)).toContain('both file April 2025: file those months through the return lifecycle');
    expect(JSON.stringify(g.warnings)).not.toContain('outside this return'); // April is in the return, only filed twice
  });

  it('G2 (mirror): Mar-Apr legacy EMP201 (8000), April corrected to 2000 and re-filed by a newer April-only legacy EMP201: refused as the same April conflict', async () => {
    const rf = await company('G2');
    const alice = await employee(rf, 'Alice');
    await run2(rf, 3, [[alice, 30_000, 4_000]]);
    const apr = await run2(rf, 4, [[alice, 30_000, 4_000]]);
    await legacyEmp201ViaRoutes(rf, '2025-03-01', '2025-04-30');
    await sql`UPDATE payroll_run_lines SET paye = 2000 WHERE run_id = ${apr}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 2000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${apr}::UUID`;
    await legacyEmp201ViaRoutes(rf, '2025-04-01', '2025-04-30');
    const g = await readiness(rf);
    const r = await finaliseEmp501(rf);
    // eslint-disable-next-line no-console
    console.log('G2', JSON.stringify(g), r.status, JSON.stringify(r.body).slice(0, 400));
    // Ruling (round 5): G2 resolves to the same conflict refusal as G1 (which row SARS holds for April cannot be told).
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('both file April 2025');
  });

  // EFb's round-5 addition: the way out. Filing April and March through the lifecycle supersedes both legacy rows.
  it('G3: filing the conflicting months through the return lifecycle (correcting the legacy rows) clears the conflict and the EMP501 finalises', async () => {
    const rf = await company('G3');
    const alice = await employee(rf, 'Alice');
    const mar = await run2(rf, 3, [[alice, 30_000, 4_000]]);
    const apr = await run2(rf, 4, [[alice, 30_000, 4_000]]);
    await legacyEmp201ViaRoutes(rf, '2025-03-01', '2025-04-30');
    await sql`UPDATE payroll_run_lines SET paye = 6000 WHERE run_id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 6000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${mar}::UUID`;
    await sql`UPDATE payroll_run_lines SET paye = 2000 WHERE run_id = ${apr}::UUID`;
    await sql`UPDATE payroll_run_headers SET total_paye = 2000, approved_at = '2025-09-15T10:00:00Z' WHERE id = ${apr}::UUID`;
    await legacyEmp201ViaRoutes(rf, '2025-04-01', '2025-04-30');
    expect((await readiness(rf)).emp201Conflicts).toHaveLength(1);
    // File a month through the lifecycle, superseding the legacy rows covering it (the 409 LEGACY_SUBMISSION_EXISTS names them).
    const fileCorrecting = async (month: number) => {
      const mm = String(month).padStart(2, '0');
      const end = new Date(Date.UTC(2025, month, 0)).toISOString().slice(0, 10);
      const f = await callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { periodStart: `2025-${mm}-01`, periodEnd: end });
      expect(f.status, JSON.stringify(f.body)).toBe(200);
      const v = (f.body as { data: { version: Row } }).data.version;
      expect((await callRoute(filingFile, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v.id, format: 'csv' })).status).toBe(200);
      const body = { versionId: v.id, reference: `7123456789L000000${mm}` };
      const first = await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' }, body);
      const ids = ((first.body as { error?: { details?: { legacySubmissionIds?: string[] } } }).error?.details?.legacySubmissionIds) ?? [];
      const r = first.status === 200 ? first : await callRoute(file, rf.fx.companyId, rf.admin.token, 'POST', { form: 'emp201' },
        { ...body, correctsLegacySubmissionIds: ids, reason: 'Filed again through the return lifecycle' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return ids.length;
    };
    expect(await fileCorrecting(4)).toBe(2); // both rows covering April
    expect(await fileCorrecting(3)).toBe(0); // the Mar-Apr row is already superseded
    const g = await readiness(rf);
    expect(g).toMatchObject({ emp201Conflicts: [], unfiledEmp201Months: [], emp201Mismatches: [], ready: true });
    const r = await finaliseEmp501(rf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(((await emp501Versions(rf))[0]!.figures as { totals: Row }).totals).toMatchObject({ paye: 8000 });
  });
});
