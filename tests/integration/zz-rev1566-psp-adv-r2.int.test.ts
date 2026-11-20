/**
 * Adversarial repros, round 2 of PR #1566 (PSP), on a throwaway PG16 cluster. Each `it` states what SHOULD hold; red = defect.
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

describe('E: the year-end status checklist (GET /api/payroll/year-end/status)', () => {
  it('its "IRP5 PAYE" and EMP501 balance are the IRP5 the filings make (PSP months out), not every line', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv2 yearend', 30_000);
    const psp = await addEmployee(pool, f, 'adv2-ye', PAY);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await month(f, 3);
    const irp5 = await getIrp5EmployeeTotals(f.company, 2027);
    const irp5Paye = Math.round(irp5.rows.reduce((t, r) => t + r.paye, 0) * 100) / 100;
    const out = await get(yearEndStatus, f, '/api/payroll/year-end/status?taxYear=2027', { taxYear: '2027' });
    const data = (out.body.data ?? out.body) as { emp501: { totalIrp5: number; balanced: boolean }; readiness: { certificatesReady: number } };
    expect({ status: out.statusCode, totalIrp5: Math.round(data.emp501.totalIrp5 * 100) / 100, balanced: data.emp501.balanced })
      .toEqual({ status: 200, totalIrp5: irp5Paye, balanced: false });
  });
});

describe('F: a reopened earlier month after a switch to PSP', () => {
  it('March, final as an employee, then PSP from April: reopening and recalculating March keeps March on the tables (or refuses)', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv2 reopen', 30_000);
    const who = await addEmployee(pool, f, 'adv2-ro', PAY);
    const march = await month(f, 3);
    const before = await lineOf(pool, march, who);
    expect(flags(before)).toEqual([]);
    const sw = await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
    expect(sw?.warnings?.[0]).toMatch(/Earlier months keep how they were taxed/);
    await reopenPayrollRun({ runId: march, companyId: f.company, userId: f.admin, reason: 'adversarial reopen' });
    const recalc = await calculatePayrollRun(march, f.company).then(() => 'costed', (e: unknown) => `refused: ${String((e as Error).message).slice(0, 80)}`);
    if (recalc !== 'costed') return;
    const after = await lineOf(pool, march, who);
    expect({ flags: flags(after), paye: after.paye, uif: after.uif }).toEqual({ flags: flags(before), paye: before.paye, uif: before.uif });
  });
});

describe('G: PSP for part of a month', () => {
  it('a switch while the month\'s run is calculated (not final), first month of the tax year: warned that the WHOLE month is now costed as a PSP', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv2 part', 30_000);
    const who = await addEmployee(pool, f, 'adv2-pt', PAY);
    const march = await month(f, 3, false); // the month being paid, calculated as an employee
    const sw = await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await calculatePayrollRun(march, f.company);
    const l = await lineOf(pool, march, who);
    expect(flags(l)).toEqual(['flat_psp']); // the whole month, 1-31 March, at 27% with no UIF
    expect(sw?.warnings ?? []).not.toEqual([]);
  });
});

describe('H: EMP501 reconciliation arithmetic with pspPaye', () => {
  it('a month whose only difference is PSP PAYE is explained, not a variance; the totals foot', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv2 recon', 30_000);
    const psp = await addEmployee(pool, f, 'adv2-rc', PAY);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await month(f, 3);
    const out = await get(emp501Recon, f, '/api/payroll/emp501/reconciliation?taxYear=2027', { taxYear: '2027' });
    const data = (out.body.data ?? out.body) as { rows: Array<{ month: number; emp201Paye: number; irp5Paye: number; pspPaye?: number; variance: number; status: string }>; totalVariance: number };
    const m = data.rows.find((r) => r.month === 3)!;
    expect(Math.round((m.emp201Paye - m.irp5Paye - (m.pspPaye ?? 0)) * 100) / 100).toBe(0); // foots
    expect(m.pspPaye).toBe(10_800);
    expect(m.status).not.toBe('variance');
  });
});
