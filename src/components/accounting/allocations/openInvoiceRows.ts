/**
 * Rows for the supplier / customer allocation pages, read the way the list APIs really answer (#1685).
 * Supplier list (/api/accounting/supplier-invoices): camelCase totalAmount / amountPaid / balance / invoiceDate.
 * Customer list (/api/accounting/customer-invoices-list): snake_case invoice_number / total_amount / amount_paid /
 * invoice_date, amounts as strings. Money is compared and subtracted in cents, never in floats (0.3 - 0.1 is not 0.2).
 */
export interface OpenInvoiceRow { id: string; invoiceNumber: string; date: string; total: number; outstanding: number }

type Raw = Record<string, unknown>;
const toCents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const dateText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v : '');

function toRow(r: Raw, f: { number: string; date: string; total: string; paid: string; balance?: string }): OpenInvoiceRow | null {
  const total = toCents(r[f.total]);
  const balance = f.balance ? toCents(r[f.balance]) : null;
  const paid = toCents(r[f.paid]) ?? 0;
  const outstanding = balance ?? (total === null ? null : total - paid);
  if (total === null || outstanding === null || outstanding <= 0) return null;
  return { id: String(r.id), invoiceNumber: String(r[f.number] ?? r.id), date: dateText(r[f.date]), total: total / 100, outstanding: outstanding / 100 };
}

const keep = (rows: (OpenInvoiceRow | null)[]): OpenInvoiceRow[] => rows.filter((r): r is OpenInvoiceRow => r !== null);

export const supplierOpenRows = (raw: Raw[]): OpenInvoiceRow[] =>
  keep(raw.map(r => toRow(r, { number: 'invoiceNumber', date: 'invoiceDate', total: 'totalAmount', paid: 'amountPaid', balance: 'balance' })));

export const customerOpenRows = (raw: Raw[]): OpenInvoiceRow[] =>
  keep(raw.map(r => toRow(r, { number: 'invoice_number', date: 'invoice_date', total: 'total_amount', paid: 'amount_paid' })));
