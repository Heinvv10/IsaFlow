/**
 * setupProgressService — single source for "what has this company set up".
 *
 * `probeSetupFacts` runs the tenant-scoped existence probes once; the setup
 * guide drawer (`completedGuideTasks`) and the Home per-module checklist
 * (`getSetupProgress`) both read the same facts, so they cannot disagree.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { countBankAccounts } from '../bank/hasBankAccountService';

export interface SetupFacts {
  logo: boolean;
  registrationNumber: boolean;
  vatNumber: boolean;
  /** A VAT period is configured; 'none' means the company is not a VAT vendor. */
  vatPeriodSet: boolean;
  payeReference: boolean;
  /** False when vat_period = 'none': the Tax checklist does not apply. */
  vatVendor: boolean;
  bankAccounts: number;
  bankTransactions: number;
  customers: number;
  customerInvoices: number;
  receipts: number;
  suppliers: number;
  supplierInvoices: number;
  fiscalPeriods: number;
  openingBalances: number;
  employees: number;
  payrollRuns: number;
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

interface CompanyRow {
  logo_data: string | null;
  registration_number: string | null;
  vat_number: string | null;
  vat_period: string | null;
  paye_reference_number: string | null;
}

interface CountRow {
  count: string;
}

const EMPTY_FACTS: SetupFacts = {
  logo: false, registrationNumber: false, vatNumber: false, vatPeriodSet: false, payeReference: false, vatVendor: true,
  bankAccounts: 0, bankTransactions: 0, customers: 0, customerInvoices: 0, receipts: 0,
  suppliers: 0, supplierInvoices: 0, fiscalPeriods: 0, openingBalances: 0, employees: 0, payrollRuns: 0,
};

// Each probe is isolated: a missing table, schema drift or one query error must
// not fail the whole endpoint. A brand-new company has empty tables everywhere,
// so the safe fallback is "nothing done".
async function safeCount(q: Promise<unknown>): Promise<number> {
  try {
    const rows = (await q) as CountRow[];
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    log.warn('Setup probe failed', { error: err }, 'setup-progress');
    return 0;
  }
}

async function safeNumber(q: Promise<number>): Promise<number> {
  try {
    return await q;
  } catch (err) {
    log.warn('Setup probe failed', { error: err }, 'setup-progress');
    return 0;
  }
}

async function safeCompany(companyId: string): Promise<CompanyRow | null> {
  try {
    const rows = (await sql`
      SELECT logo_data, registration_number, vat_number, vat_period, paye_reference_number
      FROM companies
      WHERE id = ${companyId}
      LIMIT 1
    `) as CompanyRow[];
    return rows[0] ?? null;
  } catch (err) {
    log.warn('Setup company probe failed', { error: err }, 'setup-progress');
    return null;
  }
}

export async function probeSetupFacts(companyId: string): Promise<SetupFacts> {
  const [
    company, bankAccounts, bankTransactions, customers, customerInvoices, receipts,
    suppliers, supplierInvoices, fiscalPeriods, openingBalances, employees, payrollRuns,
  ] = await Promise.all([
    safeCompany(companyId),
    // A bank account is a gl_accounts row with account_subtype='bank'; the
    // vestigial bank_accounts table is never the source of truth.
    safeNumber(countBankAccounts(companyId)),
    safeCount(sql`SELECT COUNT(*) AS count FROM bank_transactions WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM customers WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM customer_invoices WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM customer_payments WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM suppliers WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM supplier_invoices WHERE company_id = ${companyId}`),
    safeCount(sql`SELECT COUNT(*) AS count FROM fiscal_periods WHERE company_id = ${companyId}`),
    safeCount(sql`
      SELECT COUNT(*) AS count
      FROM gl_journal_entries
      WHERE company_id = ${companyId}
        AND (source = 'opening_balance' OR (source = 'manual' AND reference = 'opening_balance'))
        AND status = 'posted'
    `),
    safeCount(sql`
      SELECT COUNT(*) AS count FROM payroll_employees
      WHERE company_id = ${companyId} AND status = 'active'
    `),
    safeCount(sql`SELECT COUNT(*) AS count FROM payroll_run_headers WHERE company_id = ${companyId}`),
  ]);
  if (!company) return { ...EMPTY_FACTS, bankAccounts, bankTransactions };
  return {
    logo: Boolean(company.logo_data),
    registrationNumber: Boolean(company.registration_number),
    vatNumber: Boolean(company.vat_number),
    vatPeriodSet: Boolean(company.vat_period) && company.vat_period !== 'none',
    vatVendor: company.vat_period !== 'none',
    payeReference: Boolean(company.paye_reference_number),
    bankAccounts, bankTransactions, customers, customerInvoices, receipts,
    suppliers, supplierInvoices, fiscalPeriods, openingBalances, employees, payrollRuns,
  };
}

/** Task ids the setup guide drawer ticks automatically. */
export function completedGuideTasks(f: SetupFacts): string[] {
  const done: string[] = [];
  if (f.logo) done.push('company-logo');
  if (f.registrationNumber) done.push('company-legal');
  if (f.vatNumber) done.push('vat-number');
  if (f.fiscalPeriods > 0) done.push('fiscal-year');
  if (f.openingBalances > 0) done.push('opening-balances');
  if (f.bankAccounts > 0) done.push('bank-account');
  if (f.bankTransactions > 0) done.push('bank-transactions');
  if (f.customerInvoices > 0) done.push('customer-invoices');
  if (f.customers > 0) done.push('customers');
  if (f.suppliers > 0) done.push('suppliers');
  return done;
}

function module(
  id: SetupModuleProgress['id'], label: string, tasks: SetupTaskStatus[],
): SetupModuleProgress {
  const doneCount = tasks.filter((t) => t.done).length;
  return { id, label, tasks, doneCount, totalCount: tasks.length, complete: doneCount === tasks.length };
}

/** Pure: facts in, per-module checklist out. Tax is omitted for non-VAT-vendors. */
export function buildSetupProgress(f: SetupFacts): SetupProgress {
  const modules: SetupModuleProgress[] = [
    module('sales', 'Sales', [
      { id: 'customers', label: 'Add a customer', href: '/accounting/customers/new', done: f.customers > 0 },
      { id: 'customer-invoices', label: 'Create an invoice', href: '/accounting/customer-invoices/new', done: f.customerInvoices > 0 },
      { id: 'receipts', label: 'Record a receipt', href: '/accounting/customer-payments/new', done: f.receipts > 0 },
    ]),
    module('purchases', 'Purchases', [
      { id: 'suppliers', label: 'Add a supplier', href: '/accounting/suppliers/new', done: f.suppliers > 0 },
      { id: 'supplier-invoices', label: 'Capture a supplier invoice', href: '/accounting/supplier-invoices/new', done: f.supplierInvoices > 0 },
    ]),
    module('banking', 'Banking', [
      { id: 'bank-account', label: 'Add a bank account', href: '/accounting/bank-accounts', done: f.bankAccounts > 0 },
      { id: 'bank-transactions', label: 'Import bank transactions', href: '/accounting/bank-reconciliation/import', done: f.bankTransactions > 0 },
    ]),
    module('payroll', 'Payroll', [
      { id: 'employees', label: 'Add an employee', href: '/payroll/employees/new', done: f.employees > 0 },
      { id: 'payroll-run', label: 'Run payroll', href: '/payroll/runs', done: f.payrollRuns > 0 },
      { id: 'paye-reference', label: 'Enter your PAYE reference', href: '/accounting/company-settings', done: f.payeReference },
    ]),
  ];
  if (f.vatVendor) {
    modules.push(module('tax', 'Tax', [
      { id: 'vat-number', label: 'Enter your VAT number', href: '/accounting/company-settings', done: f.vatNumber },
      { id: 'vat-period', label: 'Choose your VAT period', href: '/accounting/company-settings', done: f.vatPeriodSet },
    ]));
  }
  const doneCount = modules.reduce((n, m) => n + m.doneCount, 0);
  const totalCount = modules.reduce((n, m) => n + m.totalCount, 0);
  return { modules, doneCount, totalCount, allComplete: doneCount === totalCount };
}

export async function getSetupProgress(companyId: string): Promise<SetupProgress> {
  return buildSetupProgress(await probeSetupFacts(companyId));
}
