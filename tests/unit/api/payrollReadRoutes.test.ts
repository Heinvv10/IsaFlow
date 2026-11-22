/**
 * #1656 round 6 (breaker H1): routes OUTSIDE pages/api/payroll that return one person's pay asked only canWrite(companyRole), so a
 * manager with Payroll unticked, or whose Approve is withheld, read per-employee pay through them. Each now asks Payroll read from the
 * database: the EMP201 drill and the EMP201 return versions answer 403, the EMP201 breakdown drops its per-payment rows (the totals stay,
 * they are the filing), and the natural-language query is neither shown the payroll tables nor allowed to read them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withNoStore', () => ({ withNoStore: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn(async () => []) }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), INTERACTIVE_REPORT_LIMIT: {}, checkAiRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/quotaUse', () => ({ markAnthropicUsedForStatus: vi.fn(), markQuotaUsed: vi.fn(), markQuotaUsedUnlessNoWork: vi.fn() }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => 'person') }));
vi.mock('@/modules/accounting/services/reports/emp201FieldDrill', () => ({ emp201FieldDrill: vi.fn(async () => ({ rows: [] })), isEmp201DrillField: () => true }));
vi.mock('@/modules/accounting/services/reports/vat201FieldDrill', () => ({ vat201FieldDrill: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/modules/accounting/services/returns/returnDrift', () => ({ listVersions: vi.fn(async () => ({ versions: [] })) }));
vi.mock('@/modules/accounting/services/reports/sarsService', async (orig) => ({
  ...(await orig<object>()),
  generateEMP201: vi.fn(async () => ({ totals: { paye: 1 }, directivePayments: [{ employeeId: 'e1', amount: 100 }] })),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { emp201FieldDrill } from '@/modules/accounting/services/reports/emp201FieldDrill';
import { listVersions } from '@/modules/accounting/services/returns/returnDrift';
import returnDrill from '../../../pages/api/accounting/sars/return-drill';
import versions from '../../../pages/api/accounting/sars/returns/[form]/versions';
import sarsEmp201 from '../../../pages/api/accounting/sars/sars-emp201';
import nlQuery from '../../../pages/api/accounting/nl-query';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const WINDOW = { from: '2026-03-01', to: '2026-03-31' };
let payrollRead = false;

function call(handler: unknown, method: string, query: Record<string, unknown>, body?: unknown) {
  const req = { method, query, body, companyId: C, companyRole: 'manager', user: { id: U }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  payrollRead = false;
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, module, action) => !(module === 'payroll' && action === 'read') || payrollRead);
});

describe('EMP201 drill (sars/return-drill)', () => {
  it('a manager without Payroll read is refused 403 and the drill never runs; VAT201 is not payroll', async () => {
    const res = await call(returnDrill, 'GET', { return: 'emp201', field: 'paye', ...WINDOW });
    expect(res.statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'read');
    expect(emp201FieldDrill).not.toHaveBeenCalled();
    expect((await call(returnDrill, 'GET', { return: 'vat201', field: '1', ...WINDOW })).statusCode).not.toBe(403);
  });
  it('with Payroll read the drill runs', async () => {
    payrollRead = true;
    expect((await call(returnDrill, 'GET', { return: 'emp201', field: 'paye', ...WINDOW })).statusCode).toBe(200);
    expect(emp201FieldDrill).toHaveBeenCalledOnce();
  });
});

describe('EMP201 return versions (sars/returns/[form]/versions)', () => {
  const q = { form: 'emp201', periodStart: '2026-03-01', periodEnd: '2026-03-31' };
  it('EMP201 without Payroll read is 403 and nothing is listed; VAT201 is open to a writer', async () => {
    expect((await call(versions, 'GET', q)).statusCode).toBe(403);
    expect(listVersions).not.toHaveBeenCalled();
    expect((await call(versions, 'GET', { ...q, form: 'vat201' })).statusCode).toBe(200);
  });
  it('with Payroll read EMP201 lists', async () => {
    payrollRead = true;
    expect((await call(versions, 'GET', q)).statusCode).toBe(200);
  });
});

describe('EMP201 breakdown (sars/sars-emp201)', () => {
  it('without Payroll read the totals stay and the per-payment rows go', async () => {
    const res = await call(sarsEmp201, 'GET', WINDOW);
    expect(res.statusCode).toBe(200);
    expect((res.sent as { data: { totals: unknown; directivePayments: unknown[] } }).data).toMatchObject({ totals: { paye: 1 }, directivePayments: [] });
  });
  it('with Payroll read the breakdown is returned', async () => {
    payrollRead = true;
    const res = await call(sarsEmp201, 'GET', WINDOW);
    expect((res.sent as { data: { directivePayments: unknown[] } }).data.directivePayments).toHaveLength(1);
  });
});

describe('nl-query', () => {
  const asked = (sqlText: string) => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ text: JSON.stringify({ sql: sqlText, explanation: 'x' }) }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const SQL = `SELECT e.first_name, e.basic_salary FROM employees e WHERE e.company_id = '${C}'`;

  it('without Payroll read a query over employees / payslips is refused 403, and the model was not shown those tables', async () => {
    const fetchMock = asked(SQL);
    const res = await call(nlQuery, 'POST', {}, { question: 'what do we pay each employee' });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    const prompt = String((JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(prompt).not.toMatch(/payslips|basic_salary/);
    expect(prompt).toMatch(/customer_invoices/);
  });

  it('with Payroll read the model is shown them', async () => {
    payrollRead = true;
    const fetchMock = asked(SQL);
    await call(nlQuery, 'POST', {}, { question: 'what do we pay each employee' });
    const prompt = String((JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(prompt).toMatch(/payslips/);
  });

  it('a query over invoices needs no Payroll read', async () => {
    asked(`SELECT invoice_number FROM customer_invoices WHERE company_id = '${C}'`);
    const res = await call(nlQuery, 'POST', {}, { question: 'list my invoices please' });
    expect(res.statusCode).not.toBe(403);
  });
});
