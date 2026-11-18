/**
 * Wave 6 PV: GET /api/payroll/pre-validation through the real route (withAuth, app_user, RLS) against the disposable
 * fixture. The IRP5 validation engine runs over every employee with a FINAL line in the tax year (approved or paid
 * AND COALESCE(approved_at, approval_grandfathered_at)), never over a status string alone. Two tenants: the other
 * company's employee with the same defect never appears, and its employee or run is 404. A viewer is 403, a bearer
 * token without the session cookie is 401, and every answer is no-store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import preValidation from '../../pages/api/payroll/pre-validation';
import { rig } from './brkr.helpers';
import { callRoute } from './r035-approval.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { preValidateTaxYear } from '../../src/modules/accounting/services/payroll/preValidationService';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import { impersonationToken } from './r035-pr2.helpers';
import { SignJWT } from 'jose';

let r: Awaited<ReturnType<typeof rig>>;
let otherCompany = '', viewer = '';
const ids: Record<string, string> = {};
const runs: Record<string, string> = {};
// Tax year 2027 = March 2026 to February 2027: a later-dated window than the other payroll suites use.
const TAX_YEAR = 2027;
// A year no other suite or seed loads codes for: the release notice's own rows.
const RELEASE_YEAR = 2089;
// What-was-paid cases: tax year 2028 (Mar 2027 - Feb 2028), with its own small code list (no 3801 in it on purpose).
const PAID_YEAR = 2028;

async function employee(company: string, number: string, taxNumber: string | null, idNumber: string | null): Promise<string> {
  return (await r.pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, tax_number, id_number)
     VALUES ($1, $2, 'Pre', $2, '2020-01-01', $3, $4) RETURNING id::text AS id`, [company, number, taxNumber, idNumber])).rows[0]!.id;
}

/** A run header with one line for the employee, set to `status` (stamped as `extra` says). */
async function runFor(company: string, emp: string, month: number, year: number, status: string, extra = ''): Promise<string> {
  const run = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, $2, $3, 'calculated') RETURNING id::text AS id`,
    [company, month, year])).rows[0]!.id;
  await r.pool.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 100000, 90000)`, [run, emp]);
  await r.pool.query(`UPDATE payroll_run_headers SET status = $2 ${extra} WHERE id = $1`, [run, status]);
  return run;
}
const STAMPED = ', approved_at = clock_timestamp()';

/** A final (stamped) line carrying PAYE and the component breakdown the calculator stores. */
async function paidLine(emp: string, month: number, year: number, gross: number, paye: number, breakdown: unknown[]): Promise<void> {
  const run = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, $2, $3, 'calculated') RETURNING id::text AS id`,
    [r.company, month, year])).rows[0]!.id;
  await r.pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay, paye, component_breakdown) VALUES ($1, $2, $3::numeric, $3::numeric - $4::numeric, $4::numeric, $5::jsonb)`,
    [run, emp, gross, paye, JSON.stringify(breakdown)]);
  await r.pool.query(`UPDATE payroll_run_headers SET status = 'approved' ${STAMPED} WHERE id = $1`, [run]);
}
const GRANDFATHERED = ', approval_grandfathered_at = clock_timestamp()';
const GOOD_TAX = '0123456789';
const GOOD_ID = '8001015009087';

type Body = { data: { taxYear: number; employeesChecked: number; errors: number; warnings: number; codeReleaseLoaded: boolean;
  employees: Array<{ employeeId: string; issues: Array<{ code: string; severity: string; field: string | null; fixHref: string }> }> } };
const ask = (query: Record<string, string>, opts: { token?: string; company?: string; headers?: Record<string, string> } = {}) => {
  const qs = new URLSearchParams(query).toString();
  return callRoute(preValidation as never, opts.token ?? r.tokens[r.admin]!, opts.company ?? r.company, 'GET', undefined,
    `/api/payroll/pre-validation${qs ? `?${qs}` : ''}`, query, opts.headers);
};
const answer = async (query: Record<string, string>) => {
  const res = await ask(query);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as Body).data;
};
const codesOf = (data: Body['data'], emp: string) => data.employees.find((e) => e.employeeId === emp)?.issues.map((i) => i.code) ?? [];

beforeAll(async () => {
  r = await rig('prevalidation');
  await r.setup();
  viewer = await r.addUser('viewer');
  ids.noTax = await employee(r.company, 'PV-NOTAX', null, GOOD_ID);
  runs.noTax = await runFor(r.company, ids.noTax, 4, 2026, 'approved', STAMPED);
  ids.badId = await employee(r.company, 'PV-BADID', GOOD_TAX, '12345');
  await runFor(r.company, ids.badId, 5, 2026, 'paid', GRANDFATHERED);
  ids.clean = await employee(r.company, 'PV-CLEAN', GOOD_TAX, GOOD_ID);
  await runFor(r.company, ids.clean, 6, 2026, 'approved', STAMPED);
  // Not final: a calculated run, and an approved row with neither stamp (status string alone).
  ids.draftOnly = await employee(r.company, 'PV-DRAFT', null, null);
  runs.draft = await runFor(r.company, ids.draftOnly, 7, 2026, 'calculated');
  ids.unstamped = await employee(r.company, 'PV-UNSTAMPED', null, null);
  await runFor(r.company, ids.unstamped, 8, 2026, 'approved');
  // Final, but in the previous tax year (February 2026 is tax year 2026).
  ids.lastYear = await employee(r.company, 'PV-LASTYEAR', null, null);
  await runFor(r.company, ids.lastYear, 2, 2026, 'approved', STAMPED);

  otherCompany = crypto.randomUUID();
  await r.pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [otherCompany, 'PV other company']);
  ids.other = await employee(otherCompany, 'PV-OTHER', null, '12345');
  runs.other = await runFor(otherCompany, ids.other, 4, 2026, 'approved', STAMPED);
}, 240000);

afterAll(async () => {
  await r.pool.query('DELETE FROM sars_source_codes WHERE effective_year = ANY($1::int[])', [[RELEASE_YEAR, PAID_YEAR]]);
  await r.pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = $1', [r.admin]);
  refreshCache();
  await r.teardown([otherCompany]);
});

// First: the no-release case needs the fixture's SARS code table as loaded (migration 999m's 2024 and 2025 sets, nothing
// for TAX_YEAR); later blocks seed it.
describe('the SARS code-release flag (the notice)', () => {
  it('no release for the tax year (other years loaded, none for this one): false', async () => {
    const rows = (await r.pool.query('SELECT count(*)::int AS n FROM sars_source_codes WHERE effective_year = $1', [TAX_YEAR])).rows[0]!.n;
    expect(rows, 'premise: the fixture loads no SARS codes for the tax year').toBe(0);
    refreshCache();
    expect((await answer({ taxYear: String(TAX_YEAR) })).codeReleaseLoaded).toBe(false);
  });
  it('a release for another year only: false for this year, true for that one', async () => {
    await r.pool.query(
      `INSERT INTO sars_source_codes (code, effective_year, category, description, status) VALUES ('3601', $1, 'income', 'Income', 'active')`,
      [RELEASE_YEAR]);
    refreshCache();
    expect((await answer({ taxYear: String(RELEASE_YEAR + 1) })).codeReleaseLoaded).toBe(false);
    expect((await answer({ taxYear: String(RELEASE_YEAR) })).codeReleaseLoaded).toBe(true);
  });
});

describe('GET pre-validation (tax year)', () => {
  it('names the employee missing a tax number (error, field tax_number, fix link to the profile field)', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR) });
    const issue = data.employees.find((e) => e.employeeId === ids.noTax)!.issues.find((i) => i.code === 'IRP5_MISSING_TAX_NUMBER')!;
    expect(issue).toMatchObject({ severity: 'error', field: 'tax_number', fixHref: `/payroll/employees/${ids.noTax}#employee-tax-number` });
  });
  it('names the employee with a bad ID number (warning, field id_number)', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR) });
    const issue = data.employees.find((e) => e.employeeId === ids.badId)!.issues.find((i) => i.code === 'IRP5_INVALID_ID')!;
    expect(issue).toMatchObject({ severity: 'warning', field: 'id_number', fixHref: `/payroll/employees/${ids.badId}#employee-id-number` });
  });
  it('checks only employees with a final line this tax year: never a draft, an unstamped approval or last year', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR) });
    expect(data.employeesChecked).toBe(3);
    const listed = data.employees.map((e) => e.employeeId);
    expect(listed).not.toContain(ids.clean);
    for (const absent of [ids.draftOnly, ids.unstamped, ids.lastYear]) expect(listed).not.toContain(absent);
    expect(data.errors).toBe(1);
    expect(data.warnings).toBe(1);
  });
  it('never lists the other company\'s employee', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR) });
    expect(data.employees.map((e) => e.employeeId)).not.toContain(ids.other);
  });
  it('the previous tax year holds only its own final line', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR - 1) });
    expect(data.employeesChecked).toBe(1);
    expect(codesOf(data, ids.lastYear!)).toContain('IRP5_MISSING_TAX_NUMBER');
  });
});

describe('GET pre-validation (one employee, one run)', () => {
  it('one employee answers only that employee', async () => {
    const data = await answer({ taxYear: String(TAX_YEAR), employeeId: ids.badId! });
    expect(data.employees.map((e) => e.employeeId)).toEqual([ids.badId]);
  });
  it('a run counts its own lines with the final ones, for the run\'s tax year', async () => {
    const data = await answer({ runId: runs.draft! });
    expect(data.taxYear).toBe(TAX_YEAR);
    expect(data.employees.map((e) => e.employeeId)).toEqual([ids.draftOnly]);
    expect(codesOf(data, ids.draftOnly!)).toEqual(expect.arrayContaining(['IRP5_MISSING_TAX_NUMBER', 'IRP5_MISSING_ID']));
  });
  it('another company\'s employee or run is 404', async () => {
    expect((await ask({ employeeId: ids.other! })).state.statusCode).toBe(404);
    expect((await ask({ runId: runs.other! })).state.statusCode).toBe(404);
  });
  it('the service\'s own company predicate: with no RLS behind it, the other company never appears', async () => {
    const data = await outsideRls(r.pool, r.company, () => preValidateTaxYear(r.company, { taxYear: TAX_YEAR }));
    expect(data).not.toBeNull();
    expect(data!.employees.map((e) => e.employeeId)).not.toContain(ids.other);
    expect(data!.employeesChecked).toBe(3);
    expect(await outsideRls(r.pool, r.company, () => preValidateTaxYear(r.company, { runId: runs.other! }))).toBeNull();
  });
});

describe('judged by what the final lines paid, not by today\'s assignments', () => {
  beforeAll(async () => {
    await r.pool.query(
      `INSERT INTO sars_source_codes (code, effective_year, category, description, status)
       VALUES ('3601', $1, 'income', 'Income', 'active'), ('3901', $1, 'lump_sum', 'Severance', 'active')`, [PAID_YEAR]);
    refreshCache();
    // A leaver: PAYE paid on 3601, every component assignment gone (none left today).
    ids.leaver = await employee(r.company, 'PV-LEAVER', GOOD_TAX, GOOD_ID);
    await r.pool.query(`UPDATE payroll_employees SET end_date = '2027-05-31' WHERE id = $1`, [ids.leaver]);
    await paidLine(ids.leaver!, 4, 2027, 300000, 60000, [{ sarsSourceCode: '3601', amount: 300000 }]);
    // A once-off severance (3901) paid with no approved directive, never an assignment.
    ids.severance = await employee(r.company, 'PV-SEVER', GOOD_TAX, GOOD_ID);
    await paidLine(ids.severance!, 5, 2027, 800000, 0, [{ sarsSourceCode: '3601', amount: 300000 }, { sarsSourceCode: ' 3901 ', amount: 500000 }]);
    // Paid only a non-cash 3801 (outside gross_pay): it has a certificate, so its codes are checked.
    ids.fringeOnly = await employee(r.company, 'PV-FRINGE', GOOD_TAX, GOOD_ID);
    await paidLine(ids.fringeOnly!, 6, 2027, 0, 0, [{ sarsSourceCode: '3801', amount: 50000, isNonCash: true }]);
    // A 3801 paid as cash (unflagged): inside gross_pay and so in 3601.
    ids.cashFringe = await employee(r.company, 'PV-CASHFRINGE', GOOD_TAX, GOOD_ID);
    await paidLine(ids.cashFringe!, 7, 2027, 320000, 0, [{ sarsSourceCode: '3601', amount: 300000 }, { sarsSourceCode: '3801', amount: 20000 }]);
    // A 3901 paid in one month and reversed in the next: nets to nil, so it was not paid (no severance warning).
    ids.reversed = await employee(r.company, 'PV-REVERSED', GOOD_TAX, GOOD_ID);
    await paidLine(ids.reversed!, 9, 2027, 800000, 0, [{ sarsSourceCode: '3601', amount: 300000 }, { sarsSourceCode: '3901', amount: 500000 }]);
    await paidLine(ids.reversed!, 10, 2027, -200000, 0, [{ sarsSourceCode: '3601', amount: 300000 }, { sarsSourceCode: '3901', amount: -500000 }]);
    // Non-cash floored per code: a 3802 that nets to -R500 does not cancel R400 of 3801; remuneration counts R400.
    // (Paid only non-cash, gross 0: with a whole-total floor the R400 - R500 = nil would read as "no payroll".)
    ids.perCode = await employee(r.company, 'PV-PERCODE', GOOD_TAX, GOOD_ID);
    await paidLine(ids.perCode!, 11, 2027, 0, 0, [
      { sarsSourceCode: '3801', amount: 400, isNonCash: true }, { sarsSourceCode: '3802', amount: -500, isNonCash: true }]);
    // A nil final line: the engine says only "no payroll" (info), which is not an issue.
    ids.nil = await employee(r.company, 'PV-NIL', GOOD_TAX, GOOD_ID);
    await paidLine(ids.nil!, 8, 2027, 0, 0, []);
  });

  it('a leaver with PAYE whose components have ended gets no false "PAYE without an income code"', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(codesOf(data, ids.leaver!)).toEqual([]);
  });
  it('a once-off 3901 paid with no approved directive raises the severance warning', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(codesOf(data, ids.severance!)).toEqual(['IRP5_SEVERANCE_WITHOUT_DIRECTIVE']);
  });
  it('an employee paid only a non-cash 3801 still gets the code checks (3801 is not in this year\'s list)', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(codesOf(data, ids.fringeOnly!)).toEqual(['IRP5_UNKNOWN_CODE']);
  });
  it('a 3801 paid in cash is named (IRP5_3801_PAID_IN_CASH)', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(codesOf(data, ids.cashFringe!)).toContain('IRP5_3801_PAID_IN_CASH');
  });
  it('a 3901 paid and reversed (nets to nil) raises no severance warning', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(codesOf(data, ids.reversed!)).toEqual([]);
  });
  it('non-cash is floored per code: R400 of 3801 beside a -R500 3802 still counts, so the codes are checked', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    // 3801 and 3802 are not in this year's list: the code checks ran (remuneration R400 > 0), not the "no payroll" exit.
    expect(codesOf(data, ids.perCode!)).toEqual(['IRP5_UNKNOWN_CODE', 'IRP5_UNKNOWN_CODE']);
  });
  it('info-only lines are neither listed nor counted (a nil line says only "no payroll")', async () => {
    const data = await answer({ taxYear: String(PAID_YEAR) });
    expect(data.employees.map((e) => e.employeeId)).not.toContain(ids.nil);
    expect(data.employeesChecked).toBe(7);
    for (const e of data.employees) expect(e.issues.every((i) => i.severity !== 'info')).toBe(true);
  });
});

describe('GET pre-validation (access)', () => {
  it('a viewer is 403 (payroll-detail roles only)', async () => {
    expect((await ask({}, { token: r.tokens[viewer] })).state.statusCode).toBe(403);
  });
  it('a bearer token without the session cookie is 401', async () => {
    expect((await ask({}, { token: '', headers: { authorization: `Bearer ${r.tokens[r.admin]}` } })).state.statusCode).toBe(401);
  });
  it('a Login-as session is 403 IMPERSONATION_FORBIDDEN, and a session with no session id 403 AGENT_FORBIDDEN', async () => {
    const login = await impersonationToken(r.pool, r.admin, r.approver);
    const agent = await new SignJWT({ sub: r.admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    for (const [token, reason] of [[login, 'IMPERSONATION_FORBIDDEN'], [agent, 'AGENT_FORBIDDEN']] as const) {
      const res = await ask({ taxYear: String(TAX_YEAR) }, { token });
      expect(res.state.statusCode).toBe(403);
      expect((res.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(reason);
    }
  });
  it('a malformed or unknown query parameter is 400', async () => {
    for (const q of [{ taxYear: '27' }, { runId: 'x' }, { employeeId: ids.badId!, runId: runs.draft! }, { year: '2027' }]) {
      expect((await ask(q)).state.statusCode, JSON.stringify(q)).toBe(400);
    }
  });
  it('every answer is no-store', async () => {
    for (const res of [await ask({}), await ask({ runId: runs.other! }), await ask({}, { token: r.tokens[viewer] })]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
