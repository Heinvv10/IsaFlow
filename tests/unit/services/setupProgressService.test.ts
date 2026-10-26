import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/hasBankAccountService', () => ({ hasBankAccount: vi.fn() }));

import { buildSetupProgress, completedGuideTasks, type SetupFacts } from '@/modules/accounting/services/core/setupProgressService';
import { NO_FACTS, ALL_FACTS } from '../helpers/setupFacts';

const mod = (p: ReturnType<typeof buildSetupProgress>, id: string) => p.modules.find((m) => m.id === id);
const doneIds = (p: ReturnType<typeof buildSetupProgress>) =>
  p.modules.flatMap((m) => m.tasks.filter((t) => t.done).map((t) => `${m.id}/${t.id}`));

describe('buildSetupProgress', () => {
  it('a fresh company with no payroll is 0 of 8: Sales, Purchases, Banking, Tax', () => {
    const p = buildSetupProgress(NO_FACTS);
    expect(p.modules.map((m) => m.id)).toEqual(['sales', 'purchases', 'banking', 'tax']);
    expect(p.doneCount).toBe(0);
    expect(p.totalCount).toBe(8);
    expect(p.allComplete).toBe(false);
  });

  // Each fact set alone must tick exactly its own task: a probe wired to the wrong fact goes red here.
  it.each<[keyof SetupFacts, string]>([
    ['hasCustomers', 'sales/customers'],
    ['hasCustomerInvoices', 'sales/customer-invoices'],
    ['hasReceipts', 'sales/receipts'],
    ['hasSuppliers', 'purchases/suppliers'],
    ['hasSupplierInvoices', 'purchases/supplier-invoices'],
    ['hasBankAccount', 'banking/bank-account'],
    ['hasBankTransactions', 'banking/bank-transactions'],
    ['vatNumber', 'tax/vat-number'],
  ])('%s alone ticks only %s', (fact, task) => {
    expect(doneIds(buildSetupProgress({ ...NO_FACTS, [fact]: true }))).toEqual([task]);
  });

  it('a company without payroll can reach all complete and the Payroll module is absent', () => {
    const p = buildSetupProgress({ ...ALL_FACTS, hasEmployees: false, hasPayrollRuns: false, payeReference: false });
    expect(mod(p, 'payroll')).toBeUndefined();
    expect(p.allComplete).toBe(true);
  });

  it('Payroll applies once there is an employee: run and PAYE reference are then open', () => {
    const p = buildSetupProgress({ ...NO_FACTS, hasEmployees: true });
    expect(mod(p, 'payroll')!.tasks.map((t) => [t.id, t.done])).toEqual([
      ['employees', true], ['payroll-run', false], ['paye-reference', false],
    ]);
    expect(buildSetupProgress({ ...NO_FACTS, hasEmployees: true, payeReference: true })
      .modules.find((m) => m.id === 'payroll')!.tasks.find((t) => t.id === 'paye-reference')!.done).toBe(true);
  });

  it('Payroll applies for a real pay run without an employee, but then has no PAYE task', () => {
    const p = buildSetupProgress({ ...NO_FACTS, hasPayrollRuns: true });
    expect(mod(p, 'payroll')!.tasks.map((t) => t.id)).toEqual(['employees', 'payroll-run']);
  });

  it('everything set up is complete', () => {
    const p = buildSetupProgress(ALL_FACTS);
    expect(p.allComplete).toBe(true);
    expect(p.doneCount).toBe(p.totalCount);
    expect(p.totalCount).toBe(11);
  });

  it('omits Tax for a company that is not a VAT vendor', () => {
    const p = buildSetupProgress({ ...ALL_FACTS, vatNumber: false, vatVendor: false });
    expect(mod(p, 'tax')).toBeUndefined();
    expect(p.allComplete).toBe(true);
  });
});

describe('completedGuideTasks', () => {
  it('maps facts to the setup guide task ids', () => {
    expect(completedGuideTasks(NO_FACTS)).toEqual([]);
    expect(completedGuideTasks({ ...NO_FACTS, logo: true, hasCustomers: true, hasBankAccount: true }).sort())
      .toEqual(['bank-account', 'company-logo', 'customers']);
  });
});
