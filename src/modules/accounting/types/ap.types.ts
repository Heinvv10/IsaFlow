/**
 * PRD-060: FibreFlow Accounting Module
 * Accounts Payable Type Definitions
 */

import type { VatType } from './gl.types';

export type SupplierInvoiceStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'partially_paid'
  | 'paid'
  | 'disputed'
  | 'cancelled';

export type InvoiceMatchStatus = 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
export type PaymentMethod = 'eft' | 'cheque' | 'cash' | 'card';
export type PaymentStatus = 'draft' | 'approved' | 'processed' | 'reconciled' | 'cancelled';

// ── Supplier Invoices ────────────────────────────────────────────────────────

export interface SupplierInvoice {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId?: string;
  grnId?: string;
  invoiceDate: string;
  dueDate?: string;
  receivedDate?: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  balance: number;
  paymentTerms?: string;
  currency: string;
  reference?: string;
  status: SupplierInvoiceStatus;
  matchStatus: InvoiceMatchStatus;
  projectId?: string;
  costCenterId?: string;
  glJournalEntryId?: string;
  sageInvoiceId?: string;
  notes?: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  supplierName?: string;
  poNumber?: string;
  items?: SupplierInvoiceItem[];
}

export interface SupplierInvoiceItem {
  id: string;
  supplierInvoiceId: string;
  poItemId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  vatClassification?: VatType;
  lineTotal: number;
  glAccountId?: string;
  projectId?: string;
  costCenterId?: string;
  createdAt: string;
}

export interface SupplierInvoiceCreateInput {
  invoiceNumber: string;
  supplierId: string;
  purchaseOrderId?: string;
  grnId?: string;
  invoiceDate: string;
  dueDate?: string;
  taxRate?: number;
  paymentTerms?: string;
  reference?: string;
  projectId?: string;
  costCenterId?: string;
  notes?: string;
  items: SupplierInvoiceItemInput[];
}

export interface SupplierInvoiceItemInput {
  poItemId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: number;
  vatClassification?: VatType;
  glAccountId?: string;
  projectId?: string;
  costCenterId?: string;
}

// ── 3-Way Match ──────────────────────────────────────────────────────────────

export interface ThreeWayMatchInput {
  poQuantity: number;
  poUnitPrice: number;
  grnQuantityReceived: number;
  invoiceQuantity: number;
  invoiceUnitPrice: number;
  tolerancePercent?: number;
}

export interface ThreeWayMatchResult {
  status: InvoiceMatchStatus;
  quantityMatch: boolean;
  priceMatch: boolean;
  grnMatch: boolean;
  mismatches: string[];
}

// ── Supplier Payments ────────────────────────────────────────────────────────

export interface SupplierPayment {
  id: string;
  paymentNumber: string;
  supplierId: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  bankAccountId?: string;
  reference?: string;
  description?: string;
  status: PaymentStatus;
  glJournalEntryId?: string;
  batchId?: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  processedAt?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  supplierName?: string;
  allocations?: PaymentAllocation[];
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  invoiceId: string;
  amountAllocated: number;
  createdAt: string;
  // Joined
  invoiceNumber?: string;
}

export interface PaymentAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface PaymentAllocationResult {
  valid: boolean;
  allocations: Array<{
    invoiceId: string;
    amount: number;
    newBalance: number;
    fullyPaid: boolean;
  }>;
  totalAllocated: number;
  unallocated: number;
  errors: string[];
}

export interface InvoiceForAllocation {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  amountPaid: number;
  balance: number;
}

// ── Aging ────────────────────────────────────────────────────────────────────

export type AgingBucketName = 'current' | 'days30' | 'days60' | 'days90' | 'days120Plus';

export interface AgingBucket {
  entityId: string;
  entityName: string;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120Plus: number;
  total: number;
}

export interface AgingInvoice {
  id: string;
  entityId: string;
  entityName: string;
  dueDate: string;
  totalAmount: number;
  amountPaid: number;
  balance: number;
}

// ── Supplier Batch Payments ──────────────────────────────────────────────────

export type BatchPaymentStatus = 'draft' | 'approved' | 'processed' | 'cancelled';

export interface SupplierPaymentBatch {
  id: string;
  batchNumber: string;
  batchDate: string;
  totalAmount: number;
  paymentCount: number;
  paymentMethod: PaymentMethod;
  bankAccountId?: string;
  status: BatchPaymentStatus;
  glJournalEntryId?: string;
  notes?: string;
  processedBy?: string;
  processedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  payments?: SupplierPayment[];
}

export interface BatchPaymentCreateInput {
  batchDate?: string;
  paymentMethod?: PaymentMethod;
  bankAccountId?: string;
  notes?: string;
  payments: {
    supplierId: string;
    invoiceAllocations: { invoiceId: string; amount: number }[];
  }[];
}
