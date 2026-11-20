/**
 * Wave 6 EZF on real PG: an EMP501 version finalised before the e@syFile BRS code fix, and the company-profile half of
 * the fix (#1688 review round 1, M1 / M4 / M5).
 *  - emp501Drift of figures recorded in the old layout (employment dates and months worked on each certificate, the
 *    company's province under 2065) shows NO drift when the payroll is unchanged;
 *  - a version stamped emp501_easyfile@1 and not filed downloads a file rebuilt in the current layout, its stored file
 *    and stamp untouched; once FILED its stored @1 bytes are served, as the record of what was filed;
 *  - the employer record never carries the province under 2065, and a company with no city is refused naming it.
 */
import { createHash } from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import { assembleEasyFileInput, EasyFileInputRefusal } from '../../src/modules/accounting/services/payroll/easyFileInput';
import { emp501Period } from '../../src/modules/accounting/services/payroll/emp501Period';
import { UNWRITTEN_FIELDS_WARNING } from '../../src/modules/accounting/services/payroll/easyFileCertificateCodes';
import { buildEmp501Figures, emp501Drift } from '../../src/modules/accounting/services/returns/emp501Figures';
import returns from '../../pages/api/payroll/emp501/returns/index';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import { request, response } from './mfa-impersonation-postgres.helpers';
import filingFile from '../../pages/api/payroll/emp501/returns/filing-file';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

// Tax year 2026's interim reconciliation: March to August 2025 (ended, so 3180 is in the past).
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
const P = emp501Period(2026, 'interim');
let rf: ReturnFixture;
const employees: string[] = [];
let seeded3601 = false;
const c = () => rf.fx.companyId;

/** The figures exactly as the code before the fix stored them (easyFileInput before #1688). */
function asStoredBeforeTheFix(figures: Row, startDates: Map<string, string>): Row {
  const employer = { ...(figures.employer as Row), physicalSuburb: 'Gauteng' };
  const certs = (figures.employees as Row[]).map((e) => {
    const { taxPeriodStart: _s, taxPeriodEnd: _e, payPeriodsInYear: _y, payPeriodsWorked: _w, ...rest } = e;
    return { ...rest, employmentStartDate: startDates.get(String(e.surname))!, employmentEndDate: null, periodsInYoA: 6 };
  });
  return { ...figures, employer, employees: certs };
}

async function asSuperuser(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // The version's trigger (969, ENABLE ALWAYS) never lets figures or a stamp change; a version as the release before
    // the fix finalised and stamped it is made here, with the trigger off inside this one transaction only.
    await client.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    for (const [text, values] of statements) await client.query(text, values);
    await client.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

describeIfDb('EZF: EMP501 versions from before the BRS code fix, and the employer record', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, employees, pay runs and return versions.');
    rf = await seedReturnFixture('EZF', DATABASE_URL!);
    seeded3601 = ((await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
      VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING RETURNING code`) as Row[]).length === 1;
    refreshCache();
    await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
      sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
      physical_postal_code = '0001', physical_city = 'Pretoria', physical_province = 'Gauteng' WHERE id = ${c()}::UUID`;
    for (const [last, start] of [['Alice', '2020-01-01'], ['Bongi', '2025-05-16']] as const) {
      const id = String(((await sql`
        INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
        VALUES (${c()}::UUID, ${last}, 'Test', ${last}, ${start}, '1980-01-01', '8001015009087', '0123456789') RETURNING id`) as Row[])[0]!.id);
      employees.push(id);
    }
    const run = String(((await sql`
      INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at)
      VALUES (${c()}::UUID, 2025, 6, 'approved', 0, '2025-07-01T10:00:00Z') RETURNING id`) as Row[])[0]!.id);
    for (const emp of employees) {
      await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
        VALUES (${run}::UUID, ${emp}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
    }
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
      VALUES (${c()}::UUID, 'EMP201', '2025-06-01', '2025-06-30', 'submitted', 'LEGACY-EMP201', now())`;
  }, 240000);

  afterAll(async () => {
    if (!rf) return;
    await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c()}::UUID)`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c()}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE id = ANY(${employees}::UUID[])`;
    if (seeded3601) await sql`DELETE FROM sars_source_codes WHERE code = '3601' AND effective_year = 2026`;
    refreshCache();
    await dropReturnFixture(rf);
  }, 120000);

  it('the employer record never carries the province under 2065', async () => {
    const input = await assembleEasyFileInput(c(), 2026, 'interim');
    expect(input.employer.physicalSuburb).toBeNull();
    expect(input.employer.physicalCity).toBe('Pretoria');
    // Hein 2026-11-20: the mandatory fields IsaFlow holds no data for are warned about, never refused.
    expect(input.warnings).toContain(UNWRITTEN_FIELDS_WARNING);
  });

  it('a company with no city is refused, naming "Physical city" (2066 is the field the BRS then needs)', async () => {
    await sql`UPDATE companies SET physical_city = NULL WHERE id = ${c()}::UUID`;
    try {
      let err: unknown;
      try { await assembleEasyFileInput(c(), 2026, 'interim'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(EasyFileInputRefusal);
      expect((err as EasyFileInputRefusal).details?.missing).toEqual(['Physical city']);
    } finally {
      await sql`UPDATE companies SET physical_city = 'Pretoria' WHERE id = ${c()}::UUID`;
    }
  });

  it('figures recorded in the old layout show no drift while the payroll is unchanged', async () => {
    const now = await buildEmp501Figures(c(), P, false);
    const old = asStoredBeforeTheFix(now as unknown as Row, new Map([['Alice', '20200101'], ['Bongi', '20250516']]));
    const drift = await emp501Drift(c(), P, old);
    expect(drift).toMatchObject({ drifted: false, fields: [], changed: [] });
    // And a real change still shows.
    const changed = { ...old, employees: (old.employees as Row[]).map((e, i) => (i === 0 ? { ...e, grossSalary3601: 1 } : e)) };
    expect((await emp501Drift(c(), P, changed)).changed).toEqual(['certificates']);
  });

  it('a version stamped @1 and not filed downloads a rebuilt current file; once filed, its stored @1 bytes', async () => {
    expect((await callRoute(returns, c(), rf.admin.token, 'POST', {}, { action: 'finalise', ...INTERIM })).status).toBe(200);
    const v = ((await sql`SELECT * FROM tax_return_versions WHERE company_id = ${c()}::UUID AND form_type = 'EMP501'`) as Row[])[0]!;
    const versionId = String(v.id);
    const startDates = new Map([['Alice', '20200101'], ['Bongi', '20250516']]);
    // What the release before the fix stored and stamped: its figures and a file in the old layout.
    const oldBody = '2010,"EZF old layout"\r\n3150,"0123456789"\r\n3215,6.0000\r\n9999,9999';
    const oldSha = createHash('sha256').update(oldBody, 'utf8').digest('hex');
    await asSuperuser([[`UPDATE tax_return_versions SET figures = $2::jsonb, filing_file_content = $3, filing_file_sha256 = $4,
      filing_file_kind = 'emp501_easyfile@1', filing_file_at = now(), filing_file_by = $5 WHERE id = $1`,
    [versionId, JSON.stringify(asStoredBeforeTheFix(v.figures as Row, startDates)), oldBody, oldSha, rf.admin.userId]]]);

    const r = await callRoute(filingFile, c(), rf.admin.token, 'POST', {}, { versionId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lines = String(r.body).split('\r\n');
    expect(lines).toEqual(expect.arrayContaining(['3100,0123456789', '3170,20250301', '3180,20250831', '3170,20250516']));
    expect(lines.some((l) => /^(2065|3150|3215),/.test(l))).toBe(false);
    // The stored file and its stamp are untouched (999v writes a stamp once).
    expect(((await sql`SELECT filing_file_content, filing_file_sha256, filing_file_kind FROM tax_return_versions WHERE id = ${versionId}::UUID`) as Row[])[0])
      .toEqual({ filing_file_content: oldBody, filing_file_sha256: oldSha, filing_file_kind: 'emp501_easyfile@1' });

    expect((await callRoute(returns, c(), rf.admin.token, 'POST', {}, { action: 'file', versionId, reference: '1234567890' })).status).toBe(200);
    const filed = await callRoute(filingFile, c(), rf.admin.token, 'POST', {}, { versionId });
    expect(filed.status).toBe(200);
    expect(String(filed.body)).toBe(oldBody);
  });

  describe('L3 (b): a tax period ending more than 30 days after today (BRS V25.3.0 p. 32)', () => {
    // The annual return of the tax year after the current one: its 3180 (end of February) is always months away.
    const now = new Date();
    const Y = (now.getMonth() >= 2 ? now.getFullYear() + 1 : now.getFullYear()) + 1;
    let seededY = false;
    const ANNUAL = { periodStart: `${Y - 1}-03-01`, periodEnd: `${Y}-02-${new Date(Y, 2, 0).getDate()}` };

    beforeAll(async () => {
      const run = String(((await sql`
        INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at)
        VALUES (${c()}::UUID, ${Y - 1}, 3, 'approved', 0, now()) RETURNING id`) as Row[])[0]!.id);
      await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
        VALUES (${run}::UUID, ${employees[0]!}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
      await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
        VALUES (${c()}::UUID, 'EMP201', ${`${Y - 1}-03-01`}::DATE, ${`${Y - 1}-03-31`}::DATE, 'submitted', 'LEGACY-EMP201-L3', now())`;
      seededY = ((await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
        VALUES ('3601', ${Y}, 'income', 'Income', 'active') ON CONFLICT DO NOTHING RETURNING code`) as Row[]).length === 1;
      refreshCache();
    });
    afterAll(async () => {
      if (seededY) await sql`DELETE FROM sars_source_codes WHERE code = '3601' AND effective_year = ${Y}`;
      refreshCache();
    });

    it('the EMP501 finalise of that period is refused, and no version is made', async () => {
      // finaliseEmp501Return already refuses a period that has not ended (400), which is stricter than BRS p. 32: a 3180
      // is never after the period's end, so once it has ended 3180 is always before today. buildIrp5File's own refusal
      // (the default, 'refuse') is the backstop for any caller that builds a filed file; easyFileBrsReview proves it.
      const r = await callRoute(returns, c(), rf.admin.token, 'POST', {}, { action: 'finalise', ...ANNUAL });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(JSON.stringify(r.body)).toContain('once its period has ended');
      expect(((await sql`SELECT count(*)::int AS n FROM tax_return_versions WHERE company_id = ${c()}::UUID
        AND period_start = ${ANNUAL.periodStart}::DATE`) as Row[])[0]!.n).toBe(0);
    });

    it('the ad-hoc e@syFile export builds the file (200) and warns, naming the date and BRS p. 32', async () => {
      const req = request({ 'sb-access-token': rf.admin.token, active_company_id: c() }, 'GET') as never as { query: Record<string, string> };
      req.query = { taxYear: String(Y), period: 'annual' };
      const out = response();
      await easyfileExport(req as never, out.res as never);
      expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
      const warnings = JSON.parse(decodeURIComponent(String(out.state.getHeader('X-IsaFlow-Warnings')))) as string[];
      expect(warnings.some((w) => /^e@syFile will refuse this file until \d{4}-\d{2}-\d{2}: .*code 3180.*BRS V25\.3\.0 p\. 32/.test(w))).toBe(true);
    });
  });
});
