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

// ── Result summary ────────────────────────────────────────────────────────────

export interface CommitSummary {
  accounts:         { created: number; skipped: number; failed: string[] };
  customers:        { created: number; skipped: number; failed: string[] };
  suppliers:        { created: number; skipped: number; failed: string[] };
  arInvoices:       { created: number; skipped: number; failed: string[] };
  apInvoices:       { created: number; skipped: number; failed: string[] };
  bankTransactions: { created: number; skipped: number; failed: string[] };
}
