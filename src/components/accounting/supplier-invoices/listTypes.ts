/**
 * Shared types for the Supplier Invoices list page and its sub-components.
 */

import type { SupplierInvoiceSort } from '@/modules/accounting/services/ap/supplierInvoiceService';

export const SUPPLIER_INVOICE_TABS = [
  'all', 'draft', 'pending_approval', 'approved',
  'partially_paid', 'paid', 'disputed', 'cancelled',
] as const;
export type SupplierInvoiceTab = typeof SUPPLIER_INVOICE_TABS[number];

export const SUPPLIER_INVOICE_TAB_LABEL: Record<SupplierInvoiceTab, string> = {
  all: 'All',
  draft: 'Draft',
  pending_approval: 'Pending',
  approved: 'Approved',
  partially_paid: 'Partial',
  paid: 'Paid',
  disputed: 'Disputed',
  cancelled: 'Cancelled',
};

export type SortKey = SupplierInvoiceSort;
export type SortOrder = 'asc' | 'desc';

export const DATE_PRESETS = [
  'all', 'this_month', 'last_month', 'last_30_days',
  'this_fy', 'last_fy', 'custom',
] as const;
export type DatePreset = typeof DATE_PRESETS[number];

export const PER_PAGE_OPTIONS = [25, 50, 100, 200] as const;
export type PerPage = typeof PER_PAGE_OPTIONS[number];

export interface SupplierOption {
  id: string;
  name: string;
}

export interface SupplierInvoiceListFilters {
  tab: SupplierInvoiceTab;
  search: string;
  supplierId: string;
  supplierLabel: string;
  datePreset: DatePreset;
  fromDate: string;
  toDate: string;
  fromAmount: string;
  toAmount: string;
  fromBalance: string;
  toBalance: string;
  sort: SortKey;
  sortOrder: SortOrder;
  page: number;
  perPage: PerPage;
  // Accountant signal filters
  missingDocument: boolean;
  possibleDuplicate: boolean;
  dueThisWeek: boolean;
  payRunReady: boolean;
}

export const AP_SIGNAL_CHIP_LABELS = {
  missingDocument: 'Missing document',
  possibleDuplicate: 'Possible duplicate',
  dueThisWeek: 'Due this week',
  payRunReady: 'Pay run ready',
} as const;
export type APSignalChip = keyof typeof AP_SIGNAL_CHIP_LABELS;
