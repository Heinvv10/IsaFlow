/**
 * PRD-060: FibreFlow Accounting Module
 * Accounts Receivable Type Definitions
 */

export type CustomerPaymentStatus = 'draft' | 'confirmed' | 'reconciled' | 'cancelled';
export type CreditNoteType = 'customer' | 'supplier';
export type CreditNoteStatus = 'draft' | 'approved' | 'applied' | 'cancelled';

// ── Customer Payments ────────────────────────────────────────────────────────

export interface CustomerPayment {
  id: string;
  paymentNumber: string;
  clientId: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod: 'eft' | 'cheque' | 'cash' | 'card';
  bankReference?: string;
  bankAccountId?: string;
  description?: string;
  status: CustomerPaymentStatus;
  glJournalEntryId?: string;
  projectId?: string;
  createdBy: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  clientName?: string;
  allocatedAmount?: number;
  allocations?: CustomerPaymentAllocation[];
}

export interface CustomerPaymentAllocation {
  id: string;
  paymentId: string;
  invoiceId: string;
  amountAllocated: number;
  createdAt: string;
  // Joined
  invoiceNumber?: string;
}

export interface CustomerPaymentCreateInput {
  clientId: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod?: 'eft' | 'cheque' | 'cash' | 'card';
  bankReference?: string;
  bankAccountId?: string;
  description?: string;
  projectId?: string;
  allocations: { invoiceId: string; amount: number }[];
}

// ── Credit Notes ─────────────────────────────────────────────────────────────

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  type: CreditNoteType;
  clientId?: string;
  customerInvoiceId?: string;
  supplierId?: string;
  supplierInvoiceId?: string;
  creditDate: string;
  reason?: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  status: CreditNoteStatus;
  glJournalEntryId?: string;
  projectId?: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  clientName?: string;
  supplierName?: string;
  invoiceNumber?: string;
}

export interface CreditNoteCreateInput {
  type: CreditNoteType;
  clientId?: string;
  customerInvoiceId?: string;
  supplierId?: string;
  supplierInvoiceId?: string;
  creditDate: string;
  reason?: string;
  subtotal: number;
  taxRate?: number;
  projectId?: string;
}

// ── Customer Write-Offs ──────────────────────────────────────────────────────

export type WriteOffStatus = 'draft' | 'approved' | 'cancelled';

export interface CustomerWriteOff {
  id: string;
  writeOffNumber: string;
  clientId: string;
  invoiceId: string;
  amount: number;
  reason: string;
  writeOffDate: string;
  status: WriteOffStatus;
  glJournalEntryId?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  clientName?: string;
  invoiceNumber?: string;
}

export interface WriteOffCreateInput {
  clientId: string;
  invoiceId: string;
  amount: number;
  reason: string;
  writeOffDate?: string;
}

// ── Recurring Invoices ───────────────────────────────────────────────────────

export type RecurringInvoiceFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annually';
export type RecurringInvoiceStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface RecurringInvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: number;
  glAccountId?: string;
}

export interface RecurringInvoice {
  id: string;
  templateName: string;
  clientId: string;
  projectId?: string;
  frequency: RecurringInvoiceFrequency;
  nextRunDate: string;
  endDate?: string;
  lastRunDate?: string;
  runCount: number;
  status: RecurringInvoiceStatus;
  description?: string;
  lineItems: RecurringInvoiceLineItem[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  paymentTerms?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  clientName?: string;
}

export interface RecurringInvoiceCreateInput {
  templateName: string;
  clientId: string;
  projectId?: string;
  frequency: RecurringInvoiceFrequency;
  nextRunDate: string;
  endDate?: string;
  description?: string;
  lineItems: RecurringInvoiceLineItem[];
  taxRate?: number;
  paymentTerms?: string;
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export type AdjustmentEntityType = 'customer' | 'supplier';
export type AdjustmentType = 'debit' | 'credit';
export type AdjustmentStatus = 'draft' | 'approved' | 'cancelled';

export interface AccountingAdjustment {
  id: string;
  adjustmentNumber: string;
  entityType: AdjustmentEntityType;
  entityId: string;
  adjustmentType: AdjustmentType;
  amount: number;
  reason: string;
  adjustmentDate: string;
  status: AdjustmentStatus;
  glJournalEntryId?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  entityName?: string;
}

export interface AdjustmentCreateInput {
  entityType: AdjustmentEntityType;
  entityId: string;
  adjustmentType: AdjustmentType;
  amount: number;
  reason: string;
  adjustmentDate?: string;
}
