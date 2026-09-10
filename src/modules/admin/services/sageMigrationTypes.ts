/**
 * sageMigrationTypes.ts
 * Shared type definitions for the Sage migration commit pipeline.
 */

// ── Row helper ────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

// ── Input entity types ────────────────────────────────────────────────────────

export interface MappedAccount {
  accountCode: string;
  accountName: string;
  accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
  /** Sage's own category (Sales, Cost of Sales, Expenses, …); bands the subtype. */
  category?: string;
  description?: string;
  isSystem?: boolean;
  isActive?: boolean;
}

export interface MappedCustomer {
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  contactPerson?: string;
  creditLimit?: number;
}

export interface MappedSupplier {
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  contactPerson?: string;
}

export interface MappedARInvoice {
  invoiceNumber: string;
  customerName: string;
  invoiceDate: string;
  dueDate?: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** Already settled at the source (Sage `Total - AmountDue`). */
  amountPaid?: number;
  reference?: string;
  sageId?: number;
}

export interface MappedAPInvoice {
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate?: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** Already settled at the source (Sage `Total - AmountDue`). */
  amountPaid?: number;
  reference?: string;
  sageId?: number;
}

export interface BankTx {
  bankAccountId: string;
  date: string;
  amount: number;
  description?: string;
  reference?: string;
}

// ── Orchestrator payload ──────────────────────────────────────────────────────

export interface CommitPayload {
  companyId: string;
  userId: string;
  pulled: {
    accounts?:         { records?: MappedAccount[] };
    customers?:        { records?: MappedCustomer[] };
    suppliers?:        { records?: MappedSupplier[] };
    arInvoices?:       { records?: MappedARInvoice[] };
    apInvoices?:       { records?: MappedAPInvoice[] };
    bankTransactions?: { bankAccountId: string; records: BankTx[] };
  };
}

// ── Per-record commit result ──────────────────────────────────────────────────

export interface CommitOutcome {
  invoiceId: string;
  created: boolean;
  /**
   * The record committed, but something in the source was not representable —
   * a non-numeric or negative paid amount, or an overpayment whose excess was
   * discarded. Surfaced in CommitSummary.warnings so the operator sees it;
   * nothing else records that the discarded credit ever existed.
   */
  warning?: string;
}

// ── Result summary ────────────────────────────────────────────────────────────

export interface CommitSummary {
  accounts:         { created: number; skipped: number; failed: string[] };
  customers:        { created: number; skipped: number; failed: string[] };
  suppliers:        { created: number; skipped: number; failed: string[] };
  arInvoices:       { created: number; skipped: number; failed: string[] };
  apInvoices:       { created: number; skipped: number; failed: string[] };
  bankTransactions: { created: number; skipped: number; failed: string[] };
  /** Non-fatal source problems, one line per affected record. */
  warnings:         string[];
}
