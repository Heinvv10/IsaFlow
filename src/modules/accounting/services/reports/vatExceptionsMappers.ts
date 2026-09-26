/**
 * VAT Exceptions Report — row mappers and small numeric/date helpers.
 * Split out of vatExceptionsTypes.ts (item 11, file-size limit) — the TYPES
 * stay there; every mapper here is a pure `DbRow -> typed row` function with
 * no query logic of its own. Re-exported from vatExceptionsTypes.ts so no
 * caller's import path changes.
 */
import type { DbRow } from '@/lib/neon';
import type {
  UncodedGlVatLine, InvoiceTaxCodeIssue, InvoiceGlVatMismatch,
  UnpostedInvoiceVatLine, DeclaredElsewhereVatLine,
} from './vatExceptionsTypes';

type Row = DbRow;

export function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dateStr(v: unknown): string {
  if (v instanceof Date) {
    // pg returns DATE columns as Date objects at local midnight — format with
    // local components; toISOString() would shift the day in UTC+ timezones.
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${m}-${d}`;
  }
  return String(v ?? '');
}

export function totalCount(rows: Row[]): number {
  return rows.length > 0 ? toNum(rows[0]!.total_count) : 0;
}

export function mapUncodedLine(r: Row): UncodedGlVatLine {
  return {
    journalEntryId: String(r.journal_entry_id),
    entryNumber: String(r.entry_number ?? ''),
    entryDate: dateStr(r.entry_date),
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    subtype: String(r.account_subtype) === 'vat_input' ? 'vat_input' : 'vat_output',
    description: String(r.description ?? ''),
    amount: r2(toNum(r.amount)),
  };
}

export function mapTaxIssue(kind: 'customer' | 'supplier') {
  return (r: Row): InvoiceTaxCodeIssue => ({
    invoiceId: String(r.invoice_id),
    invoiceKind: kind,
    invoiceNumber: String(r.invoice_number ?? ''),
    counterpartyName: String(r.counterparty_name ?? 'Unknown'),
    invoiceDate: dateStr(r.invoice_date),
    subtotal: toNum(r.subtotal),
    taxRate: r.tax_rate === null || r.tax_rate === undefined ? null : toNum(r.tax_rate),
    taxAmount: toNum(r.tax_amount),
    issue: r.tax_rate === null || r.tax_rate === undefined ? 'missing_tax_rate' : 'rate_without_vat',
  });
}

export function mapUnpostedInvoice(r: Row): UnpostedInvoiceVatLine {
  return {
    invoiceId: String(r.invoice_id),
    invoiceKind: String(r.kind) === 'supplier' ? 'supplier' : 'customer',
    invoiceNumber: String(r.invoice_number ?? ''),
    counterpartyName: String(r.counterparty_name ?? 'Unknown'),
    invoiceDate: dateStr(r.invoice_date),
    vat: r2(toNum(r.unposted_vat)),
    reason: r.reason === 'journal_reversed' || r.reason === 'journal_not_posted'
      ? r.reason
      : 'no_journal',
  };
}

export function mapMismatch(kind: 'customer' | 'supplier') {
  return (r: Row): InvoiceGlVatMismatch => {
    const invoiceVat = toNum(r.invoice_vat);
    const glVat = toNum(r.gl_vat);
    return {
      invoiceId: String(r.invoice_id),
      invoiceKind: kind,
      invoiceNumber: String(r.invoice_number ?? ''),
      counterpartyName: String(r.counterparty_name ?? 'Unknown'),
      invoiceDate: dateStr(r.invoice_date),
      invoiceVat,
      glVat,
      variance: r2(invoiceVat - glVat),
      // je_status comes from an unconditional join on the linked JE; the
      // mismatch query itself only sums VAT from POSTED lines.
      reason: r.je_status != null && String(r.je_status) !== 'posted' ? 'je_not_posted' : 'amount_mismatch',
    };
  };
}

export function mapDeclaredElsewhere(r: Row): DeclaredElsewhereVatLine {
  const markedBy = String(r.marked_by ?? '');
  const markedByName = r.marked_by_name == null ? '' : String(r.marked_by_name).trim();
  return {
    invoiceId: String(r.invoice_id),
    invoiceKind: String(r.kind) === 'supplier' ? 'supplier' : 'customer',
    invoiceNumber: String(r.invoice_number ?? ''),
    counterpartyName: String(r.counterparty_name ?? 'Unknown'),
    invoiceDate: dateStr(r.invoice_date),
    vat: r2(toNum(r.unposted_vat)),
    markedAt: r.marked_at instanceof Date ? r.marked_at.toISOString() : String(r.marked_at ?? ''),
    markedBy,
    // A joined display name (first + last, else email), falling back to the
    // raw id only when no user row resolves (e.g. the user was deleted).
    markedByName: markedByName !== '' ? markedByName : markedBy,
    markedReason: String(r.marked_reason ?? ''),
  };
}
