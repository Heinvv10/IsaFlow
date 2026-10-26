/** Auto-postings audit trail: row shapes, source labels and formatting shared with the page. */

import { formatMoney } from '@/lib/money/formatMoney';

export interface AutoEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string | null;
  source: string;
  sourceDocumentId: string | null;
  status: string;
  fiscalPeriodId: string | null;
  postedAt: string | null;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
}

export interface AutoResponse {
  entries: AutoEntry[];
  total: number;
  breakdown: Record<string, number>;
}

export const SOURCE_LABELS: Record<string, string> = {
  auto_invoice: 'Customer invoice',
  auto_payment: 'Customer payment',
  auto_supplier_invoice: 'Supplier bill',
  auto_supplier_payment: 'Supplier payment',
  auto_payroll: 'Payroll run',
  auto_bank_recon: 'Bank allocation',
  auto_credit_note: 'Credit note',
  auto_grn: 'Goods received',
  auto_write_off: 'Write-off',
  auto_adjustment: 'Adjustment',
  auto_vat_adjustment: 'VAT adjustment',
  auto_batch_payment: 'Batch payment',
  auto_recurring: 'Recurring',
  auto_purchase_order: 'Purchase order',
  auto_depreciation: 'Depreciation',
  auto_migration: 'Migration',
};

export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s;
export const PAGE_SIZE = 100;

export const fmtR = (n: number): string => (n ? formatMoney(n) : '—');
