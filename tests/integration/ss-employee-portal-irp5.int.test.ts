/**
 * Wave 6 SS-c: an employee's own IRP5 in the self-service portal, through the real portal routes on two tenants, from
 * real approved runs. Nothing here can send: see ss-employee-portal.helpers.ts. Claims:
 *  - the EMP501 figures name each certificate's payroll employee (certificateEmployees), as the file input built them;
 *  - an employee lists and downloads only their OWN certificate of a FILED version: another employee's in the same
 *    version, another company's version, a finalised-not-filed and a superseded version are absent and 404;
 *  - a version without the map (finalised before SS-c), or naming the employee twice, shows nothing (fails closed);
 *  - weekly pay: the IRP5 guard refuses the year's file input, and the list says the employee is weekly with nothing;
 *  - every answer is no-store, and nothing answers without a portal session.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import list from '../../pages/api/employee-portal/irp5/index';
import pdfRoute from '../../pages/api/employee-portal/irp5/[versionId]';
import { assembleEasyFileInput } from '@/modules/accounting/services/payroll/easyFileInput';
import { isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import type { Emp501Figures } from '@/modules/accounting/services/returns/emp501Figures';
import { rig } from './brkr.helpers';
import { approvedRun } from './pe-payslip-email.helpers';
import { captured, cleanup, doAccept, invite, lastToken, person, portal, putSetting, setPlatform, type R } from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const emp = { one: '', two: '', bee: '' };
const jars: Record<string, Record<string, string>> = {};
let figuresA: Emp501Figures;
const ver: Record<string, string> = {};

const getPdf = (jar: Record<string, string>, versionId: string) =>
  portal(async (req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { versionId };
    return (pdfRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }, 'GET', jar);
type Listed = { payFrequency: string; certificates: Array<{ versionId: string; employee: string; certificateNumber: string; tax: Array<{ code: string; amount: number }> }> };
const listed = async (jar: Record<string, string>) => (await portal(list, 'GET', jar)).body.data as Listed;
async function text(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
  return (await new PDFParse({ data: Buffer.from(pdf) }).getText()).text;
}
async function onboard(r: R, employeeId: string, ip: string): Promise<Record<string, string>> {
  expect((await invite(r, employeeId)).statusCode).toBe(200);
  const jar: Record<string, string> = {};
  expect((await doAccept(jar, { token: lastToken(), password: 'correct horse battery' }, ip)).statusCode).toBe(200);
  return jar;
}
/** Tax year 2026's annual file input, stored as EFb's finalise stores it (emp501Figures.buildEmp501Figures). */
async function figures(r: R): Promise<Emp501Figures> {
  await r.pool.query(`UPDATE companies SET paye_reference_number = '7000000000', sars_contact_first_name = 'Payroll',
    sars_contact_last_name = 'Officer', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Test Street',
    physical_postal_code = '0001' WHERE id = $1`, [r.company]);
  const input = await assembleEasyFileInput(r.company, 2026, 'annual');
  return {
    taxYear: 2026, kind: 'annual', employer: input.employer, employees: input.employees.map((e) => ({ ...e, dateOfBirth: null })),
    warnings: [], totals: { certificates: input.employees.length, paye: 0, uif: 0, sdl: 0 }, runs: [],
    certificateEmployees: input.certificateEmployees,
  };
}
/** A tax_return_versions row as EFb's lifecycle leaves it (fixture: the lifecycle itself is EFb's suite). */
async function version(r: R, figures: unknown, o: { status?: string; start?: string; end?: string; no?: number } = {}): Promise<string> {
  const status = o.status ?? 'filed';
  return String((await r.pool.query(
    `INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through,
       finalised_by, status, filed_at, filed_by)
     VALUES ($1, 'EMP501', $2, $3, $4, $5, now(), 'fixture', $6, CASE WHEN $6 = 'filed' THEN now() END, CASE WHEN $6 = 'filed' THEN 'fixture' END)
     RETURNING id`,
    [r.company, o.start ?? '2025-03-01', o.end ?? '2026-02-28', o.no ?? 1, JSON.stringify(figures), status])).rows[0]!.id);
}

beforeAll(async () => {
  a = await rig('employee-portal-irp5-a');
  b = await rig('employee-portal-irp5-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  for (const r of [a, b]) { await setPlatform(r, true); expect((await putSetting(r, true)).statusCode).toBe(200); }
  emp.one = await person(a, 'irp5-one@example.invalid', 'One');
  emp.two = await person(a, 'irp5-two@example.invalid', 'Two');
  emp.bee = await person(b, 'irp5-bee@example.invalid', 'Bee');
  await a.pool.query("UPDATE payroll_employees SET id_number = '8001015009087' WHERE id = $1", [emp.one]);
  await a.pool.query("UPDATE payroll_employees SET id_number = '8001015009087' WHERE id = $1", [emp.two]);
  await approvedRun(a, 1);
  await approvedRun(a, 2);
  await approvedRun(b, 1);
  figuresA = await figures(a);
  ver.filed = await version(a, figuresA);
  ver.finalised = await version(a, { ...figuresA, taxYear: 2025 }, { status: 'finalised', start: '2024-03-01', end: '2025-02-28' });
  ver.superseded = await version(a, { ...figuresA, taxYear: 2024 }, { status: 'superseded', start: '2023-03-01', end: '2024-02-29' });
  ver.noMap = await version(a, { ...figuresA, taxYear: 2023, certificateEmployees: undefined }, { start: '2022-03-01', end: '2023-02-28' });
  const twice = figuresA.certificateEmployees!.map((m) => ({ ...m, employeeId: emp.two }));
  ver.twice = await version(a, { ...figuresA, taxYear: 2022, certificateEmployees: twice }, { start: '2021-03-01', end: '2022-02-28' });
  ver.bFiled = await version(b, await figures(b));
  jars.one = await onboard(a, emp.one, '198.18.3.1');
  jars.two = await onboard(a, emp.two, '198.18.3.2');
  jars.bee = await onboard(b, emp.bee, '198.18.3.3');
}, 240_000);
afterAll(async () => {
  // tax_return_versions refuses DELETE (its immutability trigger): lifted for this fixture's rows only, as EFb's
  // returnVersionsFixture does, and put back as it was (ENABLE ALWAYS).
  const c = await a.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await c.query('DELETE FROM tax_return_versions WHERE company_id = ANY($1)', [[a.company, b.company]]);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('employee portal IRP5', () => {
  it('the file input names each certificate\'s payroll employee', () => {
    const ids = figuresA.certificateEmployees!.map((m) => m.employeeId).sort();
    expect(ids).toEqual([emp.one, emp.two].sort());
    expect(figuresA.certificateEmployees!.map((m) => m.certificateNumber)).toEqual(figuresA.employees.map((e) => e.certificateNumber));
  });

  it('an employee sees and downloads only their own certificate of a filed version', async () => {
    const one = await listed(jars.one!);
    const two = await listed(jars.two!);
    expect(one.certificates.map((c) => c.versionId)).toEqual([ver.filed]);
    expect(two.certificates.map((c) => c.versionId)).toEqual([ver.filed]);
    const mine = figuresA.certificateEmployees!.find((m) => m.employeeId === emp.one)!.certificateNumber;
    expect(one.certificates[0]!.certificateNumber).toBe(mine);
    expect(two.certificates[0]!.certificateNumber).not.toBe(mine);
    const pdf = await getPdf(jars.one!, ver.filed!);
    expect([pdf.statusCode, pdf.headers.get('cache-control'), pdf.headers.get('content-type')]).toEqual([200, 'no-store', 'application/pdf']);
    const body = await text(pdf.body as unknown as Buffer);
    expect(body).toContain(mine);
    expect(body).toContain('ending 9087');
    expect(body).not.toContain('8001015009087');
    // Company b's session reads nothing of a, and a's version is 404 to it; b's own version is b's.
    expect((await getPdf(jars.bee!, ver.filed!)).statusCode).toBe(404);
    expect((await listed(jars.bee!)).certificates.map((c) => c.versionId)).toEqual([ver.bFiled]);
    expect((await getPdf(jars.one!, ver.bFiled!)).statusCode).toBe(404);
    expect((await getPdf({}, ver.filed!)).statusCode).toBe(401);
    expect((await portal(list, 'GET', {})).statusCode).toBe(401);
  });

  it('only a filed version: a finalised or superseded one, or one without the map, is neither listed nor served', async () => {
    for (const v of [ver.finalised!, ver.superseded!, ver.noMap!]) expect((await getPdf(jars.one!, v)).statusCode).toBe(404);
  });

  it('a map naming the employee twice shows nothing for that version (fails closed)', async () => {
    expect((await listed(jars.two!)).certificates.map((c) => c.versionId)).not.toContain(ver.twice);
    expect((await getPdf(jars.two!, ver.twice!)).statusCode).toBe(404);
  });

  it('weekly pay: the IRP5 guard refuses the year\'s input, and the list says weekly with nothing', async () => {
    const weekly = await person(b, 'irp5-weekly@example.invalid', 'Weekly');
    // Bee is on b's approved January run; paid weekly now, the run is not at Bee's frequency: the 'irp5' guard refuses.
    await b.pool.query("UPDATE payroll_employees SET pay_frequency = 'weekly' WHERE id = $1", [emp.bee]);
    try {
      await expect(assembleEasyFileInput(b.company, 2026, 'annual')).rejects.toSatisfy(isRunKindUnsupported);
      const jar = await onboard(b, weekly, '198.18.3.4');
      await b.pool.query("UPDATE payroll_employees SET pay_frequency = 'weekly' WHERE id = $1", [weekly]);
      expect(await listed(jar)).toEqual({ payFrequency: 'weekly', certificates: [] });
    } finally {
      await b.pool.query("UPDATE payroll_employees SET pay_frequency = 'monthly' WHERE id = $1", [emp.bee]);
    }
  });
});
