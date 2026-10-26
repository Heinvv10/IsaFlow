/**
 * setupProgressService — single source for "what has this company set up".
 *
 * `probeSetupFacts` runs the tenant-scoped existence probes once; the setup
 * guide drawer (`completedGuideTasks`) and the Home per-module checklist
 * (`getSetupProgress`) both read the same facts, so they cannot disagree.
 */

import { sql } from '@/lib/neon';
import { hasBankAccount } from '../bank/hasBankAccountService';

export interface SetupFacts {
  logo: boolean;
  registrationNumber: boolean;
  vatNumber: boolean;
  /** Trimmed paye_reference_number is non-empty. */
  payeReference: boolean;
  /** False when vat_period = 'none': the Tax checklist does not apply. */
  vatVendor: boolean;
  hasBankAccount: boolean;
  hasBankTransactions: boolean;
  hasCustomers: boolean;
  /** A customer invoice that is not a draft and not cancelled. */
  hasCustomerInvoices: boolean;
  /** A customer receipt that is confirmed or reconciled. */
  hasReceipts: boolean;
  hasSuppliers: boolean;
  /** A supplier invoice that is not a draft and not cancelled. */
  hasSupplierInvoices: boolean;
  hasFiscalPeriods: boolean;
  hasOpeningBalances: boolean;
  /** An active payroll employee exists. */
  hasEmployees: boolean;
  /** A pay run that is calculated, approved or paid. */
  hasPayrollRuns: boolean;
}

export interface SetupTaskStatus {
  id: string;
  label: string;
  href: string;
  done: boolean;
}

export interface SetupModuleProgress {
  id: 'sales' | 'purchases' | 'banking' | 'payroll' | 'tax';
  label: string;
  tasks: SetupTaskStatus[];
  doneCount: number;
  totalCount: number;
  complete: boolean;
}

export interface SetupProgress {
  modules: SetupModuleProgress[];
  doneCount: number;
  totalCount: number;
  allComplete: boolean;
}

interface FactsRow {
  has_logo: boolean | null;
  has_registration: boolean | null;
  has_vat_number: boolean | null;
  has_paye: boolean | null;
  vat_vendor: boolean | null;
  has_bank_transactions: boolean;
  has_customers: boolean;
  has_customer_invoices: boolean;
  has_receipts: boolean;
  has_suppliers: boolean;
  has_supplier_invoices: boolean;
  has_fiscal_periods: boolean;
  has_opening_balances: boolean;
  has_employees: boolean;
  has_payroll_runs: boolean;
}

/**
 * One statement, every probe an EXISTS scoped by company_id. A real SQL error
 * is not swallowed: inside withAuth's transaction a caught error would leave
 * the transaction aborted, so it surfaces as a 500 instead.
 */
export async function probeSetupFacts(companyId: string): Promise<SetupFacts> {
  const [rows, bankAccountExists] = await Promise.all([
    sql<FactsRow>`
      SELECT
        c.logo_data IS NOT NULL AND c.logo_data <> '' AS has_logo,
        btrim(COALESCE(c.registration_number, '')) <> '' AS has_registration,
        btrim(COALESCE(c.vat_number, '')) <> '' AS has_vat_number,
        btrim(COALESCE(c.paye_reference_number, '')) <> '' AS has_paye,
        c.vat_period IS DISTINCT FROM 'none' AS vat_vendor,
        EXISTS (SELECT 1 FROM bank_transactions WHERE company_id = ${companyId}) AS has_bank_transactions,
        EXISTS (SELECT 1 FROM customers WHERE company_id = ${companyId}) AS has_customers,
        EXISTS (SELECT 1 FROM customer_invoices
                WHERE company_id = ${companyId} AND status NOT IN ('draft', 'cancelled')) AS has_customer_invoices,
        EXISTS (SELECT 1 FROM customer_payments
                WHERE company_id = ${companyId} AND status IN ('confirmed', 'reconciled')) AS has_receipts,
        EXISTS (SELECT 1 FROM suppliers WHERE company_id = ${companyId}) AS has_suppliers,
        EXISTS (SELECT 1 FROM supplier_invoices
                WHERE company_id = ${companyId} AND status NOT IN ('draft', 'cancelled')) AS has_supplier_invoices,
        EXISTS (SELECT 1 FROM fiscal_periods WHERE company_id = ${companyId}) AS has_fiscal_periods,
        EXISTS (SELECT 1 FROM gl_journal_entries
                WHERE company_id = ${companyId} AND status = 'posted'
                  AND (source = 'opening_balance' OR (source = 'manual' AND reference = 'opening_balance'))) AS has_opening_balances,
        EXISTS (SELECT 1 FROM payroll_employees
                WHERE company_id = ${companyId} AND status = 'active') AS has_employees,
        EXISTS (SELECT 1 FROM payroll_run_headers
                WHERE company_id = ${companyId} AND status IN ('calculated', 'approved', 'paid')) AS has_payroll_runs
      FROM (SELECT 1) AS one
      LEFT JOIN companies c ON c.id = ${companyId}
    `,
    hasBankAccount(companyId),
  ]);
  const r = rows[0];
  return {
    logo: Boolean(r?.has_logo),
    registrationNumber: Boolean(r?.has_registration),
    vatNumber: Boolean(r?.has_vat_number),
    payeReference: Boolean(r?.has_paye),
    vatVendor: r?.vat_vendor ?? true,
    hasBankAccount: bankAccountExists,
    hasBankTransactions: Boolean(r?.has_bank_transactions),
    hasCustomers: Boolean(r?.has_customers),
    hasCustomerInvoices: Boolean(r?.has_customer_invoices),
    hasReceipts: Boolean(r?.has_receipts),
    hasSuppliers: Boolean(r?.has_suppliers),
    hasSupplierInvoices: Boolean(r?.has_supplier_invoices),
    hasFiscalPeriods: Boolean(r?.has_fiscal_periods),
    hasOpeningBalances: Boolean(r?.has_opening_balances),
    hasEmployees: Boolean(r?.has_employees),
    hasPayrollRuns: Boolean(r?.has_payroll_runs),
  };
}

/** Task ids the setup guide drawer ticks automatically. */
export function completedGuideTasks(f: SetupFacts): string[] {
  const done: string[] = [];
  if (f.logo) done.push('company-logo');
  if (f.registrationNumber) done.push('company-legal');
  if (f.vatNumber) done.push('vat-number');
  if (f.hasFiscalPeriods) done.push('fiscal-year');
  if (f.hasOpeningBalances) done.push('opening-balances');
  if (f.hasBankAccount) done.push('bank-account');
  if (f.hasBankTransactions) done.push('bank-transactions');
  if (f.hasCustomerInvoices) done.push('customer-invoices');
  if (f.hasCustomers) done.push('customers');
  if (f.hasSuppliers) done.push('suppliers');
  return done;
}

function module(
  id: SetupModuleProgress['id'], label: string, tasks: SetupTaskStatus[],
): SetupModuleProgress {
  const doneCount = tasks.filter((t) => t.done).length;
  return { id, label, tasks, doneCount, totalCount: tasks.length, complete: doneCount === tasks.length };
}

/**
 * Pure: facts in, per-module checklist out. Payroll applies only to a company
 * that runs payroll (an active employee or a calculated/approved/paid run), and
 * its PAYE reference task only once there are employees; Tax is omitted for
 * non-VAT-vendors. A company never reaches "all done" on tasks that cannot apply.
 */
export function buildSetupProgress(f: SetupFacts): SetupProgress {
  const modules: SetupModuleProgress[] = [
    module('sales', 'Sales', [
      { id: 'customers', label: 'Add a customer', href: '/accounting/customers/new', done: f.hasCustomers },
      { id: 'customer-invoices', label: 'Create an invoice', href: '/accounting/customer-invoices/new', done: f.hasCustomerInvoices },
      { id: 'receipts', label: 'Record a receipt', href: '/accounting/customer-payments/new', done: f.hasReceipts },
    ]),
    module('purchases', 'Purchases', [
      { id: 'suppliers', label: 'Add a supplier', href: '/accounting/suppliers/new', done: f.hasSuppliers },
      { id: 'supplier-invoices', label: 'Capture a supplier invoice', href: '/accounting/supplier-invoices/new', done: f.hasSupplierInvoices },
    ]),
    module('banking', 'Banking', [
      { id: 'bank-account', label: 'Add a bank account', href: '/accounting/bank-accounts', done: f.hasBankAccount },
      { id: 'bank-transactions', label: 'Import bank transactions', href: '/accounting/bank-reconciliation/import', done: f.hasBankTransactions },
    ]),
  ];
  if (f.hasEmployees || f.hasPayrollRuns) {
    const tasks: SetupTaskStatus[] = [
      { id: 'employees', label: 'Add an employee', href: '/payroll/employees/new', done: f.hasEmployees },
      { id: 'payroll-run', label: 'Run payroll', href: '/payroll/runs', done: f.hasPayrollRuns },
    ];
    if (f.hasEmployees) {
      tasks.push({ id: 'paye-reference', label: 'Enter your PAYE reference', href: '/accounting/company-settings', done: f.payeReference });
    }
    modules.push(module('payroll', 'Payroll', tasks));
  }
  if (f.vatVendor) {
    modules.push(module('tax', 'Tax', [
      { id: 'vat-number', label: 'Enter your VAT number', href: '/accounting/company-settings', done: f.vatNumber },
    ]));
  }
  const doneCount = modules.reduce((n, m) => n + m.doneCount, 0);
  const totalCount = modules.reduce((n, m) => n + m.totalCount, 0);
  return { modules, doneCount, totalCount, allComplete: doneCount === totalCount };
}

export async function getSetupProgress(companyId: string): Promise<SetupProgress> {
  return buildSetupProgress(await probeSetupFacts(companyId));
}
