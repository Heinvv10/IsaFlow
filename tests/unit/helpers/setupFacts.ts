import type { SetupFacts } from '../../../src/modules/accounting/services/core/setupProgressService';

/** A company that has set nothing up and has no payroll. */
export const NO_FACTS: SetupFacts = {
  logo: false, registrationNumber: false, vatNumber: false, payeReference: false, vatVendor: true,
  hasBankAccount: false, hasBankTransactions: false, hasCustomers: false, hasCustomerInvoices: false,
  hasReceipts: false, hasSuppliers: false, hasSupplierInvoices: false, hasFiscalPeriods: false,
  hasOpeningBalances: false, hasEmployees: false, hasPayrollRuns: false,
};

/** Every checklist task done, payroll included. */
export const ALL_FACTS: SetupFacts = {
  ...NO_FACTS, vatNumber: true, payeReference: true, hasBankAccount: true, hasBankTransactions: true,
  hasCustomers: true, hasCustomerInvoices: true, hasReceipts: true, hasSuppliers: true,
  hasSupplierInvoices: true, hasEmployees: true, hasPayrollRuns: true,
};
