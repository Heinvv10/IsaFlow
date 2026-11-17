/**
 * Adversarial repros for PR #1566 (PSP) on a throwaway PG16 cluster. Each `it` states what SHOULD hold; red = confirmed defect.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, newRun } from './ts-b.helpers';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { generateUifDeclaration, getUifDeclaration } from '@/modules/accounting/services/payroll/uifDeclarationService';

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
  try {
    // The UI-19 test writes a declaration, which cleanPayrollCompanies does not know.
    await pool.query('DELETE FROM uif_declarations WHERE company_id = ANY($1)', [fixtures.map((f) => f.company)]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally { await pool.end(); }
});

const approve = (run: string) => pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [run]);
async function month(f: SeveranceFixture, m: number): Promise<string> {
  const run = await newRun(pool, f, m);
  await calculatePayrollRun(run, f.company);
  await approve(run);
  return run;
}
async function profile(company: string) {
  await pool.query(
    `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada', sars_contact_last_name = 'Lovelace',
       sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street', physical_postal_code = '0001', physical_city = 'Pretoria'
     WHERE id = $1`, [company]);
}
async function exportFile(f: SeveranceFixture) {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as never as { url: string; query: Record<string, unknown> };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
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
  await (easyfileExport as unknown as (q: unknown, s: unknown) => Promise<void>)(req, state);
  return state;
}
const lastName = async (id: string) => String((await pool.query('SELECT last_name FROM payroll_employees WHERE id = $1', [id])).rows[0]!.last_name);

describe('A: the e@syFile export (the file filed with SARS) and a PSP', () => {
  // Coordinator ruling on #1566 H1: the BRS's PSP certificate (nature of person H, V25.3.0 p. 17) needs the entity's
  // trading name and tax reference, which IsaFlow does not hold, so the PSP's months are left off every certificate
  // with a named warning (UNVERIFIED), and the company's other employees are never blocked. Never certified as A.
  it('a PSP company on a final run is not certified as a natural person (3020 = A) under 3601: left out, named; the others are filed', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv easyfile', 30_000);
    await profile(f.company);
    const psp = await addEmployee(pool, f, 'adv-psp-ef', PAY);
    await pool.query("UPDATE payroll_employees SET id_number = '8001015009087' WHERE id = $1", [psp]);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await month(f, 3);
    const ds = await getIrp5EmployeeTotals(f.company, 2027);
    expect(ds.rows.map((r) => r.employeeId)).toEqual([f.employee]);
    expect(ds.excluded.map((e) => [e.id, e.reason])).toEqual([[psp, 'personal_service_provider']]);
    expect(ds.rowsTotal + ds.excludedTotal).toBe(ds.universeTotal);
    const out = await exportFile(f);
    const file = typeof out.body === 'string' ? out.body : '';
    const warned = decodeURIComponent(String(out.headers.get('x-isaflow-warnings') ?? ''));
    expect({ ok200: out.statusCode === 200, certifiesPsp: file.includes(await lastName(psp)), certifiesOther: file.includes(await lastName(f.employee)) })
      .toEqual({ ok200: true, certifiesPsp: false, certifiesOther: true });
    expect(file).not.toContain('3020,"H"');
    expect(warned).toContain(await lastName(psp));
    expect(warned).toContain('personal service provider');
  });
});

describe('B: PSP in March, employee from April (status switch mid-year)', () => {
  it('the natural person\'s IRP5 totals do not carry the PSP month (or the year is refused)', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv switch', 30_000);
    const who = await addEmployee(pool, f, 'adv-switch', PAY);
    await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
    await month(f, 3); // 45% x 40 000 = 18 000 PAYE, the trust's
    await updatePayrollEmployee(who, f.company, { taxStatus: 'employee' });
    await month(f, 4);
    const got = await getIrp5EmployeeTotals(f.company, 2027).then((d) => d.rows.find((r) => r.employeeId === who) ?? null, () => 'refused' as const);
    if (got === 'refused') return;
    // Only April's 40 000 belongs on the natural person's certificate.
    expect(got?.grossSalary).toBe(PAY);
  });
});

describe('C: the UI-19 (UIF declaration) and a PSP', () => {
  it('a PSP (no UIF, UICA s1 "remuneration" (b)) is not declared as a UIF employee', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv uif', 30_000);
    const psp = await addEmployee(pool, f, 'adv-psp-uif', PAY);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await month(f, 3);
    const decl = await generateUifDeclaration(f.company, 2026, 3, f.admin);
    const detail = await getUifDeclaration(f.company, decl.id);
    const pspLine = detail!.lines.find((l) => l.employeeId === psp);
    expect({ count: decl.totalEmployees, pspLine: pspLine ? { leviable: pspLine.leviableSalary } : null }).toEqual({ count: 1, pspLine: null });
  });
});

describe('D: employee in March, PSP from April: the rest of the company\'s year end', () => {
  it('the other employees\' IRP5 totals are still produced (only the PSP is refused)', async () => {
    const f = await seedEmployee(pool, fixtures, 'adv block', 30_000);
    const who = await addEmployee(pool, f, 'adv-block', PAY);
    await month(f, 3);
    await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await month(f, 4);
    const other = await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee }).then(() => 'produced', () => 'refused');
    expect(other).toBe('produced');
  });
});
