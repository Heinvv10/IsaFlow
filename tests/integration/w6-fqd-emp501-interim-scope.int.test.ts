/**
 * Wave 6 FQd, breaker #1622 L-G (coordinator: scope the monthly-only certificate rule to the return's period): a company
 * paid monthly from March starts paying weekly in September (a new employee: a mid-year change is refused). Its INTERIM EMP501 (March to August, all
 * monthly) is filed; its annual (and the IRP5 for the year) is refused, naming the September weekly run.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import { dropReturnRows } from './w6-fqd-returns.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import runs from '../../pages/api/payroll/runs';
import emp501Returns from '../../pages/api/payroll/emp501/returns';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import emp501Recon from '../../pages/api/payroll/emp501/reconciliation';
import sarsEmp501 from '../../pages/api/accounting/sars/emp501';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import filingFile from '../../pages/api/accounting/sars/returns/[form]/filing-file';
import fileRoute from '../../pages/api/accounting/sars/returns/[form]/file';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { assembleEasyFileInput } from '@/modules/accounting/services/payroll/easyFileInput';
import { RunKindUnsupportedError } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';

let a: R;
type Res = { statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string; details?: { code?: string } } } };
async function route(handler: unknown, method: string, url: string, query: Record<string, unknown>, body?: unknown): Promise<Res> {
  const req = request({ 'sb-access-token': a.tokens[a.admin]!, active_company_id: a.company }, method) as never as
    { url: string; query: Record<string, unknown>; body: unknown };
  req.query = query;
  req.url = url;
  req.body = body;
  const out = response();
  await (handler as Route)(req as never, out.res as never);
  return out.state as Res;
}
const ok = (res: Res) => expect([res.statusCode, res.body.error?.message]).toEqual([200, undefined]);

beforeAll(async () => {
  a = await rig('fqd-interim-scope');
  await a.setup();
  await a.pool.query(
    `UPDATE companies SET paye_reference_number = '7123456789', sdl_reference_number = 'L123456789', uif_reference_number = 'U123456789',
            sars_contact_first_name = 'Pat', sars_contact_last_name = 'Payroll', sars_contact_telephone = '0110000000',
            physical_address_line1 = '1 Main Road', physical_postal_code = '2000', physical_city = 'Johannesburg' WHERE id = $1`, [a.company]);
  // What IRP5 pre-validation needs to pass (as EFb's suites seed it): the year's source codes, the employee's identity.
  await a.pool.query(`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
    VALUES ('3601', 2027, 'income', 'Income', 'active') ON CONFLICT DO NOTHING`);
  refreshCache();
  const { employee: monthly } = await a.employee(20000);
  await a.pool.query(`UPDATE payroll_employees SET date_of_birth = '1980-01-01', id_number = '8001015009087', tax_number = '0123456789'
    WHERE id = $1`, [monthly]);
  // April 2026, monthly: in the 2027 interim. EMP201 finalised and filed, so the interim can be.
  const april = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 4, year: 2026 } })).body.data!.id);
  expect((await a.api.calculate(april)).statusCode).toBe(200);
  expect((await a.api.approve(april)).statusCode).toBe(200);
  const f = await route(finalise, 'POST', '/api/accounting/sars/returns/emp201/finalise', { form: 'emp201' }, { periodStart: '2026-04-01', periodEnd: '2026-04-30' });
  ok(f);
  const versionId = String((f.body.data!.version as { id: string }).id);
  ok(await route(filingFile, 'POST', '/api/accounting/sars/returns/emp201/filing-file', { form: 'emp201' }, { versionId, format: 'csv' }));
  ok(await route(fileRoute, 'POST', '/api/accounting/sars/returns/emp201/file', { form: 'emp201' }, { versionId, reference: '7123456789L00000004' }));
  // From September, a new employee paid weekly (a change mid-year is refused for an existing one): a final weekly run
  // in the annual's months only.
  const { employee: weekly } = await a.employee(1000);
  expect((await a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${weekly}/pay-frequency`, weekly,
    { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
  const sep = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { frequency: 'weekly', periodStart: '2026-09-07' } })).body.data!.id);
  expect((await a.api.calculate(sep)).statusCode).toBe(200);
  expect((await a.api.approve(sep)).statusCode).toBe(200);
}, 240_000);
afterAll(async () => {
  await dropReturnRows(a.pool, a.company);
  await cleanup(a);
});

describe('L-G: the monthly-only certificate rule judges the return\'s own period', () => {
  it('the interim (March to August, monthly only) is finalised', async () => {
    await expect(assembleEasyFileInput(a.company, 2027, 'interim')).resolves.toBeTruthy();
    const res = await route(emp501Returns, 'POST', '/api/payroll/emp501/returns', {},
      { action: 'finalise', periodStart: '2026-03-01', periodEnd: '2026-08-31' });
    ok(res);
  });

  it('the annual is refused, naming the September weekly run', async () => {
    const e = await assembleEasyFileInput(a.company, 2027, 'annual').catch((x: unknown) => x);
    expect([e instanceof RunKindUnsupportedError, (e as Error).message]).toEqual([true, expect.stringContaining('weekly run for 7–13 Sep 2026')]);
    const res = await route(easyfile, 'GET', '/api/payroll/irp5/easyfile-export', { taxYear: '2027' });
    expect([res.statusCode, res.body.error?.details?.code]).toEqual([409, 'RUN_KIND_UNSUPPORTED']);
  });

  it('the EMP501 reconciliation: the interim (?period=interim) serves March to August; the annual refuses', async () => {
    const interim = await route(emp501Recon, 'GET', '/api/payroll/emp501/reconciliation', { taxYear: '2027', period: 'interim' });
    expect(interim.statusCode).toBe(200);
    const rows = (interim.body.data as { rows: Array<{ monthLabel: string; irp5Paye: number }> }).rows;
    expect(rows.map((r) => r.monthLabel)).toEqual(['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026']);
    const annual = await route(emp501Recon, 'GET', '/api/payroll/emp501/reconciliation', { taxYear: '2027' });
    expect([annual.statusCode, annual.body.error?.details?.code]).toEqual([409, 'RUN_KIND_UNSUPPORTED']);
  });

  // The legacy summary reads payroll_runs/payslips, tables that no longer exist (a 500 on master for any tenant, not
  // FQd's): judged only on the refusal, which the interim no longer meets and the annual still does.
  it('the legacy EMP501 summary: the interim is not refused for the September run; the annual is', async () => {
    const interim = await route(sarsEmp501, 'GET', '/api/accounting/sars/emp501', { taxYear: '2027', period: 'interim' });
    expect(interim.body.error?.details?.code).not.toBe('RUN_KIND_UNSUPPORTED');
    const annual = await route(sarsEmp501, 'GET', '/api/accounting/sars/emp501', { taxYear: '2027' });
    expect([annual.statusCode, annual.body.error?.details?.code]).toEqual([409, 'RUN_KIND_UNSUPPORTED']);
  });
});
