/**
 * VAT Exceptions Report — types and row mappers.
 * Query orchestration lives in vatExceptionsService.ts.
 */

import type { DbRow } from '@/lib/neon';

type Row = DbRow;

export interface UncodedGlVatLine {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  subtype: 'vat_input' | 'vat_output';
  description: string;
  amount: number;
}

export interface InvoiceTaxCodeIssue {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  issue: 'missing_tax_rate' | 'rate_without_vat';
}

export interface InvoiceGlVatMismatch {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  invoiceVat: number;
  glVat: number;
  variance: number;
}

export interface VatControlRecon {
  outputVat201: number;
  outputGl: number;
  outputVariance: number;
  inputVat201: number;
  inputGl: number;
  inputVariance: number;
  netVat201: number;
  netGl: number;
  netVariance: number;
  unpostedCustomerVat: number;
  unpostedCustomerCount: number;
  unpostedSupplierVat: number;
  unpostedSupplierCount: number;
}

export interface VatExceptionsReport {
  periodStart: string;
  periodEnd: string;
  uncodedGlLines: UncodedGlVatLine[];
  uncodedGlLineCount: number;
  invoiceTaxCodeIssues: InvoiceTaxCodeIssue[];
  invoiceTaxCodeIssueCount: number;
  invoiceGlMismatches: InvoiceGlVatMismatch[];
  invoiceGlMismatchCount: number;
  controlRecon: VatControlRecon;
  totalExceptions: number;
}

export function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
    };
  };
}
