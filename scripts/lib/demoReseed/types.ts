/** Shared shapes of the pure generator. */

import type { PayrollComponent } from '../../../src/modules/accounting/services/payroll/payrollTypes';
import type { Window } from './dates';
import type { JournalBuilder, Row } from './journal';
import type { Rng } from './rng';

export type { Row };

/** Demo GL account ids the seed posts to, resolved once by role then by code (write.ts resolveAccounts). */
export interface AccountRefs {
  bank: string;
  receivable: string;
  payable: string;
  vatOutput: string;
  vatInput: string;
  salesRevenue: string;
  serviceRevenue: string;
  otherIncome: string;
  openingEquity: string;
  bankCharges: string;
  labour: string;
  paye: string;
  uif: string;
  sdl: string;
  equipment: string;
  vehicles: string;
  accumulatedDepreciation: string;
  depreciationExpense: string;
  /** Supplier expense codes (5100, 5400, 5600) to ids, default_expense where a code is missing. */
  expenseByCode: Record<string, string>;
}

export type DocFamilyKey = 'customer_invoice' | 'customer_receipt' | 'supplier_payment' | 'quotation';
export interface DocFamily { prefix: string; padding: number }

export interface GenerateInput {
  today: string;
  seed: number;
  companyId: string;
  actorId: string;
  accounts: AccountRefs;
  docs: Record<DocFamilyKey, DocFamily>;
  /** The statutory rate, in percent, from src/lib/vat/standardRate.ts (never a literal here). */
  vatRatePct: number;
  payroll: {
    basicComponent: PayrollComponent;
    leaveTypes: Array<{ id: string; accrualDays: number }>;
  };
}

/** Every table the seed inserts into, in parent-first insert order. */
export const SEED_TABLES = [
  'customers', 'customer_contacts', 'suppliers', 'items', 'gl_journal_entries', 'gl_journal_lines',
  'customer_invoices', 'customer_invoice_items', 'customer_payments', 'customer_payment_allocations',
  'customer_quotes', 'customer_quote_lines',
  'supplier_invoices', 'supplier_invoice_items', 'supplier_payments', 'payment_allocations',
  'payroll_employees', 'payroll_employee_components', 'payroll_run_headers', 'payroll_run_lines', 'payroll_leave_balances',
  'bank_import_batches', 'bank_reconciliations', 'bank_transactions',
  'assets', 'practice_clients', 'practice_client_contacts', 'practice_jobs', 'time_entries',
  'expense_claims', 'expense_claim_lines',
] as const;
export type SeedTable = (typeof SEED_TABLES)[number];

export interface Ctx {
  input: GenerateInput;
  win: Window;
  rng: Rng;
  jb: JournalBuilder;
  rows: Record<SeedTable, Row[]>;
  /** Highest number used per document family (next_number is this + 1). */
  used: Record<DocFamilyKey, number>;
}

export interface DemoData {
  rows: Record<SeedTable, Row[]>;
  nextNumbers: Record<DocFamilyKey, number>;
  openingCapitalCents: number;
}
