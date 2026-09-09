/**
 * PRD-060: FibreFlow Accounting Module
 * General Ledger Type Definitions
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** The GL account types, as a runtime value — validators (MCP `list_gl_accounts`)
 *  need to reject an unknown type without re-listing the union by hand. */
export const GL_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export type GLAccountType = (typeof GL_ACCOUNT_TYPES)[number];

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
  | 'disposal_profit_loss'
  | 'equity'
  | 'retained_earnings'
  | 'opening_balance_equity'
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

/**
 * Must stay a mirror of the gl_journal_entries_source_check CHECK constraint
 * (see migration 509). When the two drifted, four write paths emitted a value
 * the database rejected with 23514 — and the two asset paths swallowed the
 * error and returned null, so asset disposals silently never reached the GL.
 * Adding a member here without also widening the constraint reintroduces
 * exactly that failure; tests/unit/services/glEntrySourceConstraint.test.ts
 * pins the two lists together.
 */
export const GL_ENTRY_SOURCES = [
  'manual',
  'auto_invoice',
  'auto_payment',
  'auto_grn',
  'auto_credit_note',
  'auto_bank_recon',
  'auto_supplier_invoice',
  'auto_supplier_payment',
  'auto_write_off',
  'auto_adjustment',
  'auto_vat_adjustment',
  'auto_vat_submission',
  'auto_batch_payment',
  'auto_recurring',
  'auto_purchase_order',
  'auto_depreciation',
  'auto_payroll',
  'auto_migration',
  'auto_loan_payment',
  'auto_expense_claim',
  'auto_expense_receipt',
  'auto_bank_transfer',
  'auto_asset_disposal',
  'auto_asset_expense',
  'auto_gl_import',
  // Year-end close. Admitted by migration 627 once postClosingJournal gained
  // its own validateJournalEntry check — it INSERTs at status='posted', so no
  // other guard sees it.
  'year_end',
] as const;

export type GLEntrySource = (typeof GL_ENTRY_SOURCES)[number];

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
  /**
   * VAT Act s17(2)(a): input tax on this account is denied (entertainment).
   * Distinct from defaultVatCode, which only says what to default to — an
   * account can default to 'none' and still allow a standard claim.
   */
  vatInputDenied?: boolean;
  createdAt: string;
  updatedAt: string;
  // Tree display
  children?: GLAccount[];
  balance?: number;
  /** True when at least one journal line references this account — code edit locked. */
  hasTransactions?: boolean;
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
  /** Id of the record that caused this journal, keyed by `source`. */
  sourceRecordId?: string;
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
  buId?: string;
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
  /** captured_documents(id) ONLY — it carries an FK. Anything else throws. */
  sourceDocumentId?: string;
  /**
   * Id of the record that caused this journal — a reconciliation, a supplier
   * invoice — read against `source`, which says which table it points at.
   * Not the OCR document: that is sourceDocumentId.
   */
  sourceRecordId?: string;
  fiscalPeriodId?: string;
  /**
   * Human-facing document reference (claim number, disposal tag, import batch).
   * Distinct from entry_number, which is generated by trg_gl_je_entry_number and
   * is UNIQUE per company — callers that stuffed a reference into entry_number
   * instead were one same-month repeat away from a unique-violation.
   */
  reference?: string;
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
