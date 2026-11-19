/**
 * Wave 6 FQd, breaker #1622 M-D (coordinator: IRP5/EMP501 monthly-only this wave): a tax year with an approved weekly
 * run is refused by name (409 RUN_KIND_UNSUPPORTED) on every certificate route and service, before anything is certified:
 * the IRP5 data service (MCP irp5_data), the IRP5 summary, the e@syFile export, the EMP501 export, reconciliation and
 * summary, and the IRP5 pre-validation. Another tenant's monthly-only year is not refused.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import summary from '../../pages/api/payroll/irp5/summary';
import emp501Export from '../../pages/api/payroll/emp501/export';
import emp501Recon from '../../pages/api/payroll/emp501/reconciliation';
import sarsEmp501 from '../../pages/api/accounting/sars/emp501';
import preValidation from '../../pages/api/payroll/pre-validation';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { RunKindUnsupportedError } from '@/modules/accounting/services/payroll/payrollRunKindGuard';

let a: R;
let b: R;
type Res = { statusCode: number; body: { error?: { code?: string; message?: string; details?: { code?: string } } } };

async function get(r: R, route: unknown, url: string): Promise<Res> {
  const req = request({ 'sb-access-token': r.tokens[r.admin]!, active_company_id: r.company }, 'GET') as never as { url: string; query: Record<string, unknown> };
  req.query = { taxYear: '2027' };
  req.url = url;
  const out = response();
  await (route as Route)(req as never, out.res as never);
  return out.state as Res;
}
const ROUTES: Array<[string, unknown, string]> = [
  ['IRP5 summary', summary, '/api/payroll/irp5/summary'], ['e@syFile export', easyfile, '/api/payroll/irp5/easyfile-export'],
  ['EMP501 export', emp501Export, '/api/payroll/emp501/export'], ['EMP501 reconciliation', emp501Recon, '/api/payroll/emp501/reconciliation'],
  ['EMP501 summary', sarsEmp501, '/api/accounting/sars/emp501'], ['IRP5 pre-validation', preValidation, '/api/payroll/pre-validation'],
];

beforeAll(async () => {
  a = await rig('fqd-irp5-weekly');
  b = await rig('fqd-irp5-monthly');
  await a.setup();
  await b.setup();
  const { employee } = await a.employee(5000);
  expect((await a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${employee}/pay-frequency`, employee,
    { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
  const run = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined,
    { body: { frequency: 'weekly', periodStart: '2027-01-04' } })).body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
  expect((await a.api.approve(run)).statusCode).toBe(200);
  await b.employee(20000);
  const monthly = String((await b.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 1, year: 2027 } })).body.data!.id);
  expect((await b.api.calculate(monthly)).statusCode).toBe(200);
  expect((await b.api.approve(monthly)).statusCode).toBe(200);
}, 240_000);
afterAll(async () => { await cleanup(a); await cleanup(b); });

describe('IRP5 and EMP501 are monthly-only this wave', () => {
  it.each(ROUTES)('%s refuses a tax year with an approved weekly run (409 RUN_KIND_UNSUPPORTED, named)', async (_name, route, url) => {
    const res = await get(a, route, url);
    expect([res.statusCode, res.body.error?.details?.code]).toEqual([409, 'RUN_KIND_UNSUPPORTED']);
    expect(res.body.error?.message).toContain('weekly run for 4–10 Jan 2027');
    expect(res.body.error?.message).toContain('IRP5 and EMP501 certificates cover monthly runs only in this release');
  });

  it('the IRP5 data service (MCP irp5_data) refuses it too', async () => {
    const e = await getIrp5EmployeeTotals(a.company, 2027).catch((x: unknown) => x);
    expect([e instanceof RunKindUnsupportedError, (e as RunKindUnsupportedError).action]).toEqual([true, 'irp5']);
  });

  // The legacy /api/accounting/sars/emp501 reads payroll_runs/payslips, tables that no longer exist (a 500 on master
  // for any tenant, not FQd's): it is judged only on the refusal above.
  it.each(ROUTES.filter(([name]) => name !== 'EMP501 summary'))('%s serves a monthly-only tax year (another tenant)', async (_name, route, url) => {
    const res = await get(b, route, url);
    expect(res.body.error?.details?.code).not.toBe('RUN_KIND_UNSUPPORTED');
    expect(res.statusCode).toBeLessThan(500);
  });
});
