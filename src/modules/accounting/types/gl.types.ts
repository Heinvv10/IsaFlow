/**
 * PRD-060: FibreFlow Accounting Module
 * General Ledger Type Definitions
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export type GLAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type GLAccountSubtype =
  | 'bank'
  | 'receivable'
  | 'payable'
  | 'tax'
  | 'vat_input'
  | 'vat_output'
  | 'inventory'
  | 'fixed_asset'
  | 'accumulated_depreciation'
  | 'cost_of_sales'
  | 'default_revenue'
  | 'revenue'
  | 'other_income'
  | 'operating_expense'
  | 'default_expense'
  | 'admin_expense'
  | 'depreciation_expense'
  | 'equity'
  | 'retained_earnings'
  | 'other_current_asset'
  | 'other_current_liability'
  | 'other';

export type VatType =
  | 'standard'       // 15% standard rate
  | 'zero_rated'     // 0% zero-rated supplies
  | 'exempt'         // Exempt (no VAT, not recoverable)
  | 'capital_goods'  // Standard-rated capital goods (separate VAT201 box)
  | 'export'         // Zero-rated exports from RSA
  | 'imported'       // Imported goods/services
  | 'reverse_charge' // Domestic reverse charge (DRC)
  | 'bad_debt'       // Bad debt recovery
  | 'no_vat';        // No VAT applicable

export type GLEntrySource =
  | 'manual'
  | 'auto_invoice'
  | 'auto_payment'
  | 'auto_grn'
  | 'auto_credit_note'
  | 'auto_bank_recon'
  | 'auto_supplier_invoice'
  | 'auto_supplier_payment'
  | 'auto_write_off'
  | 'auto_adjustment'
  | 'auto_vat_adjustment'
  | 'auto_vat_submission'
  | 'auto_batch_payment'
  | 'auto_recurring'
  | 'auto_purchase_order'
  | 'auto_depreciation'
  | 'auto_payroll'
  | 'auto_migration';

// ── Recurring Journals ────────────────────────────────────────────────────────

export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annually';
export type RecurringStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface RecurringJournal {
  id: string;
  templateName: string;
  description?: string;
  frequency: RecurringFrequency;
  nextRunDate: string;
  endDate?: string;
  lastRunDate?: string;
  runCount: number;
  status: RecurringStatus;
  lines: JournalLineInput[];
  totalAmount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringJournalCreateInput {
  templateName: string;
  description?: string;
  frequency: RecurringFrequency;
  nextRunDate: string;
  endDate?: string;
  lines: JournalLineInput[];
}

// ── VAT Adjustments ──────────────────────────────────────────────────────────

export type VATAdjustmentType = 'input' | 'output';
export type VATAdjustmentStatus = 'draft' | 'approved' | 'cancelled';

export interface VATAdjustment {
  id: string;
  adjustmentNumber: string;
  adjustmentDate: string;
  vatPeriod?: string;
  adjustmentType: VATAdjustmentType;
  amount: number;
  reason: string;
  status: VATAdjustmentStatus;
  glJournalEntryId?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VATAdjustmentCreateInput {
  adjustmentDate: string;
  vatPeriod?: string;
  adjustmentType: VATAdjustmentType;
  amount: number;
  reason: string;
}

export type GLEntryStatus = 'draft' | 'posted' | 'reversed';

export type FiscalPeriodStatus = 'open' | 'closing' | 'closed' | 'locked';

// ── Chart of Accounts ────────────────────────────────────────────────────────

export interface GLAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: GLAccountType;
  accountSubtype?: string;
  parentAccountId?: string;
  isActive: boolean;
  isSystemAccount: boolean;
  description?: string;
  normalBalance: 'debit' | 'credit';
  level: number;
  displayOrder: number;
  /** Actual bank account number (only for bank-subtype accounts) */
  bankAccountNumber?: string;
  /** Default VAT treatment for transactions posted to this account */
  defaultVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
  createdAt: string;
  updatedAt: string;
  // Tree display
  children?: GLAccount[];
  balance?: number;
}

// ── Fiscal Periods ───────────────────────────────────────────────────────────

export interface FiscalPeriod {
  id: string;
  periodName: string;
  periodNumber: number;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
  closedBy?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Journal Entries ──────────────────────────────────────────────────────────

export interface JournalEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  fiscalPeriodId?: string;
  description?: string;
  source: GLEntrySource;
  sourceDocumentId?: string;
  status: GLEntryStatus;
  postedBy?: string;
  postedAt?: string;
  reversedBy?: string;
  reversedAt?: string;
  reversalOfId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Detail
  lines?: JournalLine[];
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  glAccountId: string;
  debit: number;
  credit: number;
  description?: string;
  projectId?: string;
  costCenterId?: string;
  vatType?: VatType;
  createdAt: string;
  // Joined
  accountCode?: string;
  accountName?: string;
}

export interface JournalEntryCreateInput {
  entryDate: string;
  description?: string;
  source?: GLEntrySource;
  sourceDocumentId?: string;
  fiscalPeriodId?: string;
  lines: JournalLineInput[];
}

export interface JournalLineInput {
  glAccountId: string;
  debit: number;
  credit: number;
  description?: string;
  projectId?: string;
  costCenterId?: string;
  buId?: string;
  vatType?: VatType;
}

// ── Validation Results ───────────────────────────────────────────────────────

export interface JournalValidationResult {
  valid: boolean;
  totalDebit: number;
  totalCredit: number;
  difference: number;
  errors: string[];
}

export interface LineValidationResult {
  valid: boolean;
  error?: string;
}

// ── Reports — re-exported from companion file for backward compatibility ──────

export type {
  TrialBalanceRow,
  TrialBalanceReport,
  IncomeStatementLineItem,
  IncomeStatementReport,
  BalanceSheetLineItem,
  BalanceSheetReport,
  VAT201Box,
  VAT201Transaction,
  VATReturnReport,
  ProjectProfitabilityReport,
  CashFlowReport,
} from './gl.report.types';
