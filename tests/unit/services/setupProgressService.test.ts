import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/hasBankAccountService', () => ({ countBankAccounts: vi.fn() }));

import {
  buildSetupProgress, completedGuideTasks, type SetupFacts,
} from '@/modules/accounting/services/core/setupProgressService';

const NONE: SetupFacts = {
  logo: false, registrationNumber: false, vatNumber: false, vatPeriodSet: false, payeReference: false,
  vatVendor: true, bankAccounts: 0, bankTransactions: 0, customers: 0, customerInvoices: 0, receipts: 0,
  suppliers: 0, supplierInvoices: 0, fiscalPeriods: 0, openingBalances: 0, employees: 0, payrollRuns: 0,
};
const ALL: SetupFacts = {
  ...NONE, vatNumber: true, vatPeriodSet: true, payeReference: true, bankAccounts: 1, bankTransactions: 1,
  customers: 1, customerInvoices: 1, receipts: 1, suppliers: 1, supplierInvoices: 1, employees: 1, payrollRuns: 1,
};
const mod = (p: ReturnType<typeof buildSetupProgress>, id: string) => p.modules.find((m) => m.id === id)!;

describe('buildSetupProgress', () => {
  it('a fresh company is 0 of N with nothing complete', () => {
    const p = buildSetupProgress(NONE);
    expect(p.modules.map((m) => m.id)).toEqual(['sales', 'purchases', 'banking', 'payroll', 'tax']);
    expect(p.doneCount).toBe(0);
    expect(p.totalCount).toBe(12);
    expect(p.allComplete).toBe(false);
    expect(p.modules.every((m) => !m.complete)).toBe(true);
  });

  it('one customer marks Sales 1 done, and only Sales', () => {
    const p = buildSetupProgress({ ...NONE, customers: 1 });
    expect(mod(p, 'sales').doneCount).toBe(1);
    expect(mod(p, 'sales').tasks.find((t) => t.id === 'customers')!.done).toBe(true);
    expect(p.doneCount).toBe(1);
  });

  it('payroll needs employees, a run and the PAYE reference', () => {
    expect(mod(buildSetupProgress({ ...NONE, employees: 2 }), 'payroll').doneCount).toBe(1);
    expect(mod(buildSetupProgress({ ...NONE, payeReference: true }), 'payroll').tasks.find((t) => t.id === 'paye-reference')!.done).toBe(true);
    expect(mod(buildSetupProgress({ ...NONE, payrollRuns: 1 }), 'payroll').tasks.find((t) => t.id === 'payroll-run')!.done).toBe(true);
  });

  it('everything set up is complete', () => {
    const p = buildSetupProgress(ALL);
    expect(p.allComplete).toBe(true);
    expect(p.doneCount).toBe(p.totalCount);
    expect(p.modules.every((m) => m.complete)).toBe(true);
  });

  it('omits Tax for a company that is not a VAT vendor', () => {
    const p = buildSetupProgress({ ...ALL, vatNumber: false, vatPeriodSet: false, vatVendor: false });
    expect(p.modules.some((m) => m.id === 'tax')).toBe(false);
    expect(p.allComplete).toBe(true);
  });
});

describe('completedGuideTasks', () => {
  it('maps facts to the setup guide task ids', () => {
    expect(completedGuideTasks(NONE)).toEqual([]);
    expect(completedGuideTasks({ ...NONE, logo: true, customers: 1, bankAccounts: 2 }).sort())
      .toEqual(['bank-account', 'company-logo', 'customers']);
  });
});
