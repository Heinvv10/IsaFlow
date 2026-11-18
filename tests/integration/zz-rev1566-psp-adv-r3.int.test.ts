/**
 * Adversarial repros, round 3 of PR #1566 (PSP), on a throwaway PG16 cluster. Each `it` states what SHOULD hold; red = defect.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, lineOf, newRun } from './ts-b.helpers';
import yearEndStatus from '../../pages/api/payroll/year-end/status';
import emp501Recon from '../../pages/api/payroll/emp501/reconciliation';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const PAY = 40_000;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

const approve = (run: string) => pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [run]);
async function month(f: SeveranceFixture, m: number, final = true): Promise<string> {
  const run = await newRun(pool, f, m);
  await calculatePayrollRun(run, f.company);
  if (final) await approve(run);
  return run;
}
async function get(route: unknown, f: SeveranceFixture, url: string, query: Record<string, string>) {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as never as { url: string; query: Record<string, unknown> };
  req.url = url; req.query = query;
  const state = {
    statusCode: 200, body: undefined as unknown, headers: new Map<string, unknown>(),
    status(c: number) { this.statusCode = c; return this; },
    setHeader(n: string, v: unknown) { this.headers.set(n.toLowerCase(), v); return this; },
    getHeader(n: string) { return this.headers.get(n.toLowerCase()); },
    removeHeader(n: string) { this.headers.delete(n.toLowerCase()); },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    end(b?: unknown) { if (b !== undefined) this.body = b; return this; },
  };
  await (route as (q: unknown, s: unknown) => Promise<void>)(req, state);
  return state as { statusCode: number; body: { data?: Record<string, unknown> } & Record<string, unknown> };
}
const flags = (l: { results: Array<{ code: string; treatment?: string }> }) =>
  l.results.filter((r) => r.code === 'PAYE_OUTSIDE_TABLES').map((r) => r.treatment);


describe('I: a reopened month and a PSP entity change (company -> trust, both flat_psp)', () => {
  it('March final as a PSP company (27%), entity changed to trust, March reopened and recalculated: stays at 27% (or refuses)', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv3 entity', 30_000);
    const who = await addEmployee(pool, f, 'adv3-en', PAY);
    await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const march = await month(f, 3);
    const before = await lineOf(pool, march, who);
    await updatePayrollEmployee(who, f.company, { pspEntityType: 'trust' });
    await reopenPayrollRun({ runId: march, companyId: f.company, userId: f.admin, reason: 'adversarial reopen' });
    const recalc = await calculatePayrollRun(march, f.company).then(() => 'costed', () => 'refused');
    if (recalc === 'refused') return;
    const after = await lineOf(pool, march, who);
    expect({ paye: after.paye }).toEqual({ paye: before.paye });
  });
});

describe('J: a 3701 that reached a PSP without any writer (direct row), and an employee edit between reopen and recalc', () => {
  it('calculate refuses a PSP with a 3701 assignment, whatever wrote it (409 PSP_COMPONENT_REFUSED)', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv3 travel', 30_000);
    const who = await addEmployee(pool, f, 'adv3-tr', PAY);
    await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const comp = (await pool.query("INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, 'Travel', ' 3701', 'earning') RETURNING id", [f.company])).rows[0]!.id;
    await pool.query("INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 5000, '2026-01-01')", [who, comp]);
    const run = await newRun(pool, f, 3);
    const got = await calculatePayrollRun(run, f.company).then(() => 'costed', (e: unknown) => String((e as { code?: string }).code));
    expect(got).toBe('PSP_COMPONENT_REFUSED');
  });
  it('reopen, then employee -> PSP, then recalc: refused 409 PSP_STATUS_CHANGED_SINCE_APPROVAL', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv3 edit', 30_000);
    const who = await addEmployee(pool, f, 'adv3-ed', PAY);
    const march = await month(f, 3);
    await reopenPayrollRun({ runId: march, companyId: f.company, userId: f.admin, reason: 'adversarial reopen' });
    await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const got = await calculatePayrollRun(march, f.company).then(() => 'costed', (e: unknown) => String((e as { code?: string }).code));
    expect(got).toBe('PSP_STATUS_CHANGED_SINCE_APPROVAL');
  });
});
