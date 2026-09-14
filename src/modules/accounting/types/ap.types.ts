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
/**
 * `'contra'` (migration 540) records a settlement where NO CASH MOVED — the
 * debt was netted against a loan, intercompany or director's account. Without
 * it such a settlement is indistinguishable from an EFT that never happened,
 * which is the finding behind R371,470 of AP that could not be cleared
 * correctly. The other four all imply a real bank movement.
 */
export type PaymentMethod = 'eft' | 'cheque' | 'cash' | 'card' | 'contra';
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
  // Accountant signals (computed server-side on list queries)
  hasDocument?: boolean;
  hasPo?: boolean;
  isPossibleDuplicate?: boolean;
  paymentRunEligible?: boolean;
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
  /** ISO-4217 currency code, defaults to ZAR */
  currencyCode?: string;
  /** Rate to convert currencyCode → ZAR. 1.0 for ZAR invoices. */
  exchangeRate?: number;
}

/**
 * Importer-only. `taxAmount` is an unbounded VAT figure, so it is deliberately
 * NOT part of `SupplierInvoiceItemInput`: `pages/api/accounting/supplier-invoices.ts`
 * forwards request-body line objects, and a client-settable tax amount there
 * would be an input-VAT overstatement vector. It is honoured only when the
 * input also carries `trustSourceTax: true`, which no route can set from a body.
 */
export interface SupplierInvoiceImportItemInput extends SupplierInvoiceItemInput {
  /** Exact tax for this line, used INSTEAD of deriving it from `taxRate`. Finite, >= 0. */
  taxAmount?: number;
}

/**
 * The shape a migration passes: it carries the source system's authoritative
 * tax per line, because re-deriving it from a 2 dp rate moves the stored total
 * off the source's by cents and the row then disagrees with its own journal.
 */
export interface SupplierInvoiceImportInput extends Omit<SupplierInvoiceCreateInput, 'items'> {
  /** Opt-in that makes per-line `taxAmount` authoritative. Importers only. */
  trustSourceTax: true;
  items: SupplierInvoiceImportItemInput[];
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
  /** @deprecated Use qtyTolerancePercent + priceTolerancePercent. Kept for backward-compat — applied to both checks when set. */
  tolerancePercent?: number;
  qtyTolerancePercent?: number;
  priceTolerancePercent?: number;
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
  /**
   * Sum of open dispute amounts for this entity's invoices. Populated by AR
   * aging only; AP leaves it undefined. When present, the current/days30…
   * buckets have already had this amount subtracted, so `total` is the
   * "outstanding excluding disputed" figure that collections owns.
   */
  disputed?: number;
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
  /** Open-dispute amount for this invoice (AR only). Subtracted from balance before bucketing. */
  disputedAmount?: number;
  /**
   * True when the invoice carries no due date and `dueDate` above is its
   * invoice date instead. These rows used to be filtered out of the aging
   * entirely; they are aged conservatively and flagged so a reader can see
   * that the age is derived rather than recorded.
   */
  dueDateMissing?: boolean;
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
