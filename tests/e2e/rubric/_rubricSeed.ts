/**
 * The rubric harness's seed (master plan wave 4, MW). Through the API only (the approver's membership excepted, see
 * _rubricSession.ts), into this run's sandbox, and idempotent per run id: every object is found by a name or reference
 * derived from the run id before it is made, so a re-run with the same RUBRIC_RUN_ID reuses it.
 *
 * Seeds: the approver as a second member (R-035 two-person path), the net-pay default (empty, so net pay credits the
 * bank), a 30-day customer, earning components 3601 and 3607, two salaried employees, an approved (open) invoice, a
 * draft invoice, one imported CSV with a line equal to the open invoice and one spend line, and (seedPayRun, after T3)
 * a calculated pay run for the current month.
 */
import { randomUUID } from 'node:crypto';
import type { Api } from '../golden-paths/_api';
import { todayInSast } from '../../../src/lib/saDateParser';
import { REQUESTER_EMAIL, employeeNumber } from './_rubricGuard';
import { addApprover, assertWriteScope, type RubricEnv, type Sandbox } from './_rubricSession';

type Named = { id: string; name: string; sarsSourceCode?: string };
type Employee = { id: string; employeeNumber: string; firstName: string; lastName: string };
type Run = { id: string; periodMonth: number; periodYear: number; status: string };
type Invoice = { id: string; status: string; total_amount: number | string; invoice_number?: string };

export interface Seeded {
  approver: { role: string; added: boolean };
  customer: { id: string; name: string; email: string };
  overtimeId: string;
  employees: Array<{ id: string; employeeNumber: string; name: string }>;
  run: { id: string; month: number; year: number; status: string };
  openInvoice: { id: string; total: number };
  draftInvoiceId: string;
  bankAccountId: string;
  bankRefs: { matching: string; spend: string };
}

export const SPEND = -250;
/** The seeded invoices' totals (VAT 15% on one line of R1 000 / R100). T2's own invoice (R1 667.50) never matches. */
const OPEN_TOTAL = 1150;
const DRAFT_TOTAL = 115;
const sameCents = (amount: number | string, total: number) => Math.round(Number(amount) * 100) === total * 100;

export async function seedSandbox(env: RubricEnv, api: Api, sandbox: Sandbox): Promise<Omit<Seeded, 'run'>> {
  await assertWriteScope(api, REQUESTER_EMAIL, sandbox);
  const tag = env.runId.toUpperCase();
  const approver = await addApprover(env, sandbox);

  const customerName = `0RS Rubric Customer ${env.runId}`;
  const email = `rubric-${env.runId}@example.invalid`; // never deliverable, and the send is intercepted besides
  const found = await api.get<Named[]>(`/api/accounting/customers?q=${encodeURIComponent(customerName)}`);
  const customerId = found.find((c) => c.name === customerName)?.id ?? (await api.post<{ id: string }>('/api/accounting/customers', {
    name: customerName, email, payment_terms: 30, payment_terms_type: 'days', default_discount: 0, default_vat_type: 'standard',
  })).id;

  const components = await api.get<Named[]>('/api/payroll/components');
  const component = async (name: string, sarsSourceCode: string) => components.find((c) => c.sarsSourceCode === sarsSourceCode)?.id
    ?? (await api.post<Named>('/api/payroll/components', { name, sarsSourceCode, componentType: 'earning' })).id;
  const salaryId = await component('Basic Salary', '3601');
  const overtimeId = await component('Overtime', '3607');

  // The list is not paged (GET returns every employee); `include=terminated` adds leavers, whose numbers are taken too.
  const existing = await api.get<Employee[]>('/api/payroll/employees?include=terminated');
  const employees: Seeded['employees'] = [];
  for (const [n, firstName, lastName, salary] of [[1, 'Ruby', 'Rubric', 30000], [2, 'Sipho', 'Rubric', 24000]] as const) {
    const number = employeeNumber(env.runId, n);
    let id = existing.find((e) => e.employeeNumber === number)?.id;
    if (!id) {
      id = (await api.post<{ id: string }>('/api/payroll/employees', {
        employeeNumber: number, firstName, lastName, employmentType: 'permanent', startDate: '2024-01-01',
      })).id;
      await api.post(`/api/payroll/employees/${id}/components`, { componentId: salaryId, amount: salary, effectiveFrom: '2024-01-01' });
    }
    employees.push({ id, employeeNumber: number, name: `${firstName} ${lastName}` });
  }

  const invoices = (await api.get<{ invoices: Invoice[] }>(
    `/api/accounting/customer-invoices-list?q=${encodeURIComponent(customerName)}&limit=100&status=draft&status=approved`)).invoices;
  const create = async (description: string, unitPrice: number) => (await api.post<{ id: string }>('/api/accounting/customer-invoices-create', {
    clientId: customerId, invoiceDate: todayInSast(), taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1,
    items: [{ description, quantity: 1, unitPrice }],
  })).id;
  // Found by status AND seeded total: T2's leftover (approved, if its cancel failed) is another amount.
  let openId = invoices.find((i) => i.status === 'approved' && sameCents(i.total_amount, OPEN_TOTAL))?.id;
  if (!openId) {
    openId = await create(`Rubric open invoice ${env.runId}`, 1000);
    await api.post('/api/accounting/customer-invoices-detail', { id: openId, action: 'approve' });
  }
  const open = await api.get<Invoice>(`/api/accounting/customer-invoices-detail?id=${openId}`);
  const draftInvoiceId = invoices.find((i) => i.status === 'draft' && sameCents(i.total_amount, DRAFT_TOTAL))?.id
    ?? await create(`Rubric draft ${env.runId}`, 100);

  const accounts = await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts');
  if (!accounts[0]) throw new Error('the sandbox has no bank account (the standard chart makes one)');
  const bankAccountId = accounts[0].id;
  const bankRefs = { matching: `RBR-${tag}-IN`, spend: `RBR-${tag}-OUT` };
  await importLines(api, bankAccountId, bankRefs, Number(open.total_amount));

  return {
    approver, customer: { id: customerId, name: customerName, email }, overtimeId, employees,
    openInvoice: { id: openId, total: Number(open.total_amount) },
    draftInvoiceId, bankAccountId, bankRefs,
  };
}

/**
 * The current month's pay run, calculated. Seeded after T3: once a month has a calculated run, a new employee's salary
 * may not start in it ("already paid"), so T3 must create its employee first. A re-run of a run id cannot repeat T3.
 */
export async function seedPayRun(api: Api): Promise<Seeded['run']> {
  const [year, month] = todayInSast().split('-').map(Number) as [number, number];
  const runs = await api.get<Run[]>('/api/payroll/runs');
  let run = runs.find((r) => r.periodMonth === month && r.periodYear === year);
  if (!run) run = await api.post<Run>('/api/payroll/runs', { month, year });
  if (run.status === 'draft' || run.status === 'calculated') {
    await api.post(`/api/payroll/runs/${run.id}/calculate`);
    run = await api.get<Run>(`/api/payroll/runs/${run.id}`);
  }
  return { id: run.id, month, year, status: run.status };
}

/** A line by reference, in any status, or undefined. */
export async function bankLine(api: Api, bankAccountId: string, ref: string, status?: string): Promise<{ id: string; status: string } | undefined> {
  const q = new URLSearchParams({ bank_account_id: bankAccountId, search: ref, ...(status ? { status } : {}) });
  const res = await api.get<{ transactions: Array<{ id: string; status: string; description?: string }> }>(`/api/accounting/bank-transactions?${q}`);
  return res.transactions.find((t) => (t.description ?? '').includes(ref));
}

async function importLines(api: Api, bankAccountId: string, refs: Seeded['bankRefs'], amount: number): Promise<void> {
  if (await bankLine(api, bankAccountId, refs.matching)) return;
  const date = todayInSast().replace(/-/g, '/');
  await api.post('/api/accounting/bank-transactions-bulk-commit', {
    bankAccountId, bulkImportId: randomUUID(), bulkSequence: 1, filename: `${refs.matching}.csv`, fileType: 'csv',
    statementDate: todayInSast(), bankFormat: 'fnb', applyBankRules: false,
    csvContent: [
      'Date,Description,Amount,Balance,Reference',
      `${date},${refs.matching} receipt,${amount.toFixed(2)},${(10000 + amount).toFixed(2)},${refs.matching}`,
      `${date},${refs.spend} spend,${SPEND.toFixed(2)},${(10000 + amount + SPEND).toFixed(2)},${refs.spend}`,
    ].join('\n'),
  });
}

/** Net pay credits the bank: the Default Accounts `payroll_net_pay` row is left (or set) empty where the server has it. */
export async function netPayToBank(api: Api, serverHasSetting: boolean): Promise<Record<string, unknown>> {
  if (!serverHasSetting) return { payrollNetPay: 'not applicable: the server predates the Default Accounts payroll_net_pay row (#1175)' };
  const { mappings } = await api.get<{ mappings: Record<string, unknown> }>('/api/accounting/default-accounts');
  const current = mappings.payroll_net_pay;
  if (typeof current === 'string' && current) {
    await api.post('/api/accounting/default-accounts', { mappings: { payroll_net_pay: null }, loaded: { payroll_net_pay: current } });
    return { payrollNetPay: 'cleared (net pay credits the bank role)', was: current };
  }
  return { payrollNetPay: 'empty (net pay credits the bank role)' };
}
