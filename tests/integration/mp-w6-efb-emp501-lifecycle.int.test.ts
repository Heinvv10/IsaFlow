/**
 * The EMP501 lifecycle through the real routes (wave 6 EFb), on real PG with two tenants:
 *  - finalise is refused (409 EMP501_NOT_READY, no row) while IRP5 pre-validation reports an error (a missing tax
 *    number) or a month with a pay run has no filed EMP201;
 *  - the version stores the e@syFile input; the filing file is built from it (a later payroll change does not change
 *    the bytes), stamped once (sha256 = the bytes' hash), and only then may it be marked filed, which creates the
 *    sars_submissions EMP501 row the version names (F11);
 *  - another company's version is 404 on every route and changes no row; a viewer is 403.
 */
import { createHash, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import listSubmissions from '../../pages/api/accounting/sars/sars-submissions';
import returns from '../../pages/api/payroll/emp501/returns/index';
import filingFile from '../../pages/api/payroll/emp501/returns/filing-file';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

// Tax year 2026's interim reconciliation: March to August 2025 (ended).
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
let rf: ReturnFixture;
const other = { companyId: randomUUID(), userId: randomUUID(), token: '' };
const employees: string[] = [];
const c = () => rf.fx.companyId;
const versionsOf = async (companyId = c()) =>
  ((await sql`SELECT * FROM tax_return_versions WHERE company_id = ${companyId}::UUID ORDER BY version_no`) as Row[]);
const get = (token = rf.admin.token, companyId = c()) => callRoute(returns, companyId, token, 'GET', INTERIM);
const post = (body: Record<string, unknown>, token = rf.admin.token, companyId = c()) =>
  callRoute(returns, companyId, token, 'POST', {}, body);
const download = (versionId: string, token = rf.admin.token, companyId = c()) =>
  callRoute(filingFile, companyId, token, 'POST', {}, { versionId });
/** A POST without the CSRF header (the cookie alone, as a cross-site form would send). */
async function downloadWithoutCsrf(versionId: string): Promise<number> {
  const req = request({ 'sb-access-token': rf.admin.token, active_company_id: c() }, 'POST') as never as
    { body: unknown; query: Record<string, string>; headers: Record<string, string> };
  delete req.headers['x-csrf-token'];
  req.body = { versionId };
  req.query = {};
  const out = response();
  await filingFile(req as never, out.res as never);
  return out.state.statusCode;
}

async function employee(last: string, taxNumber: string | null, companyId = c()): Promise<string> {
  const id = String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
    VALUES (${companyId}::UUID, ${last}, 'Test', ${last}, '2020-01-01', '1980-01-01', '8001015009087', ${taxNumber})
    RETURNING id`) as Row[])[0]!.id);
  employees.push(id);
  return id;
}

async function finalRun(month: number, lines: Array<[string, number, number]>, companyId = c()): Promise<string> {
  const run = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at)
    VALUES (${companyId}::UUID, 2025, ${month}, 'approved', 0, '2025-04-01T10:00:00Z') RETURNING id`) as Row[])[0]!.id);
  for (const [emp, gross, paye] of lines) {
    await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
      VALUES (${run}::UUID, ${emp}::UUID, ${gross}, ${gross}, ${paye}, 177.12, 177.12, ${gross / 100},
        ${JSON.stringify([{ sarsSourceCode: '3601', amount: gross }])}::JSONB)`;
  }
  return run;
}

describeIfDb('EMP501 lifecycle (interim 2026), two tenants', () => {
  let alice = '', bob = '', versionId = '', body = '', seeded3601 = false;

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, employees, pay runs and return versions.');
    rf = await seedReturnFixture('EFB', DATABASE_URL!);
    // PAYE needs an income code paid (IRP5_PAYE_WITHOUT_INCOME_CODE): the schema-only fixture loads no SARS codes.
    seeded3601 = ((await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
      VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING RETURNING code`) as Row[]).length === 1;
    refreshCache();
    await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
      sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
      physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = ${c()}::UUID`;
    alice = await employee('Alice', '0123456789');
    bob = await employee('Bob', null); // a pre-validation error: no tax number
    await finalRun(3, [[alice, 30_000, 4_000], [bob, 20_000, 2_000]]);
    // A September hire with no tax number: outside the interim period, so it blocks the annual return only.
    await finalRun(9, [[await employee('Carol', null), 25_000, 3_000]]);
    // The second tenant, with its own final run.
    await sql`INSERT INTO companies (id, name) VALUES (${other.companyId}::UUID, 'EFb other tenant')`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${other.userId}, ${`efb-${other.userId}@example.invalid`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${other.companyId}::UUID, ${other.userId}, 'admin')`;
    other.token = await new SignJWT({ sub: other.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    await finalRun(3, [[await employee('Zed', '0123456789', other.companyId), 99_000, 9_000]], other.companyId);
  }, 240000);

  afterAll(async () => {
    if (!rf) return;
    await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${other.companyId}::UUID)`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ${other.companyId}::UUID`;
    await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c()}::UUID)`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c()}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE id = ANY(${employees}::UUID[])`;
    await sql`DELETE FROM company_users WHERE company_id = ${other.companyId}::UUID`;
    await sql`DELETE FROM users WHERE id = ${other.userId}`;
    await sql`DELETE FROM companies WHERE id = ${other.companyId}::UUID`;
    if (seeded3601) await sql`DELETE FROM sars_source_codes WHERE code = '3601' AND effective_year = 2026`;
    refreshCache();
    await dropReturnFixture(rf);
  }, 120000);

  it('GET shows what blocks a finalise: the pre-validation error and the unfiled EMP201 month', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    const readiness = (r.body as { data: { readiness: Row } }).data.readiness;
    expect(readiness).toMatchObject({ validationErrors: 1, employeesWithErrors: ['Test Bob'], unfiledEmp201Months: ['2025-03'], ready: false });
  });

  it('finalise despite a pre-validation error: 409 EMP501_NOT_READY, no version', async () => {
    const r = await post({ action: 'finalise', ...INTERIM });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('EMP501_NOT_READY');
    expect(JSON.stringify(r.body)).toContain('Test Bob');
    expect(await versionsOf()).toHaveLength(0);
  });

  it('with the tax number fixed, an unfiled EMP201 month still refuses (409), no version', async () => {
    await sql`UPDATE payroll_employees SET tax_number = '0123456789' WHERE id = ${bob}::UUID`;
    const r = await post({ action: 'finalise', ...INTERIM });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('2025-03');
    expect(await versionsOf()).toHaveLength(0);
  });

  it('every month filed: the interim finalises although the September hire has an error (PV scoped to March-August); finalise stores the e@syFile input; the response carries totals, never the certificates', async () => {
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
      VALUES (${c()}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', 'LEGACY-EMP201', now())`;
    const r = await post({ action: 'finalise', ...INTERIM });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/8001015009087|0123456789/);
    const [v] = await versionsOf();
    versionId = String(v!.id);
    expect(v).toMatchObject({ form_type: 'EMP501', status: 'finalised', filing_file_sha256: null });
    const figures = v!.figures as { kind: string; employees: Row[]; totals: Row; employer: Row };
    expect(figures).toMatchObject({ kind: 'interim', totals: { certificates: 2, paye: 6000 } });
    expect(figures.employer.reconciliationPeriod).toBe(202608);
    // The other tenant's R99 000 is not in this company's figures.
    expect(figures.employees.map((e) => e.grossSalary3601)).toEqual([30_000, 20_000]);
  });

  it('mark filed before the filing file was downloaded: 409, no submission', async () => {
    const r = await post({ action: 'file', versionId, reference: '1234567890' });
    expect(r.status).toBe(409);
    expect(((await sql`SELECT COUNT(*)::INT AS n FROM sars_submissions WHERE company_id = ${c()}::UUID AND form_type = 'EMP501'`) as Row[])[0]!.n).toBe(0);
  });

  it('another tenant and a viewer cannot read the file: 404 / 403, no stamp', async () => {
    expect((await download(versionId, other.token, other.companyId)).status).toBe(404);
    expect((await download(versionId, rf.viewer.token)).status).toBe(403);
    expect((await post({ action: 'amend', versionId, reason: 'x' }, other.token, other.companyId)).status).toBe(404);
    expect((await versionsOf())[0]).toMatchObject({ filing_file_sha256: null, status: 'finalised' });
  });

  it('the filing file is never written by a GET, nor by a POST without the CSRF token', async () => {
    expect((await callRoute(filingFile, c(), rf.admin.token, 'GET', { versionId })).status).toBe(405);
    expect(await downloadWithoutCsrf(versionId)).toBe(403);
    expect((await versionsOf())[0]).toMatchObject({ filing_file_sha256: null });
  });

  it('the filing file is built from the version: the stamp is its sha256, and a later payroll change does not move it', async () => {
    const r = await download(versionId);
    expect(r.status).toBe(200);
    body = String(r.body);
    expect(body.split('\r\n')).toContain('2031,202608');
    const sha = createHash('sha256').update(body, 'utf8').digest('hex');
    expect((await versionsOf())[0]).toMatchObject({ filing_file_sha256: sha, filing_file_kind: 'emp501_easyfile@1', filing_file_by: rf.admin.userId });
    expect((await versionsOf())[0]!.filing_file_content).toBe(body); // stored: a re-download serves these bytes (H2)
    await sql`UPDATE payroll_run_lines SET paye = paye * 10 WHERE employee_id = ${alice}::UUID`;
    expect(String((await download(versionId)).body)).toBe(body);
    await sql`UPDATE payroll_run_lines SET paye = paye / 10 WHERE employee_id = ${alice}::UUID`;
  });

  it('mark filed creates the sars_submissions EMP501 row the filed version names', async () => {
    const r = await post({ action: 'file', versionId, reference: '1234567890' });
    expect(r.status).toBe(200);
    const [v] = await versionsOf();
    expect(v).toMatchObject({ status: 'filed', filed_reference: '1234567890' });
    const subs = (await sql`SELECT id, form_type, status, period_start::TEXT AS s, period_end::TEXT AS e FROM sars_submissions
      WHERE company_id = ${c()}::UUID AND form_type = 'EMP501'`) as Row[];
    expect(subs).toEqual([{ id: v!.sars_submission_id, form_type: 'EMP501', status: 'submitted', s: INTERIM.periodStart, e: INTERIM.periodEnd }]);
    expect(await versionsOf(other.companyId)).toHaveLength(0);
  });

  it('the annual return is blocked by the September hire (PV over the whole year): 409 naming her, no annual version', async () => {
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
      VALUES (${c()}::UUID, 'EMP201', '2025-09-01', '2025-09-30', 'submitted', 'LEGACY-EMP201-SEP', now())`;
    const r = await post({ action: 'finalise', periodStart: '2025-03-01', periodEnd: '2026-02-28' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('Test Carol');
    expect(JSON.stringify(r.body)).not.toContain('is not filed');
    expect(await versionsOf()).toHaveLength(1); // the interim version only
  });

  it('a non-payroll role reading the filed submission sees totals only: no certificate, name, ID or tax number', async () => {
    const r = await callRoute(listSubmissions, c(), rf.viewer.token, 'GET', { type: 'EMP501' });
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).toContain('"certificates":2');
    expect(text).not.toMatch(/8001015009087|0123456789|Alice|Bob|grossSalary3601|employees|employer/);
  });
});
