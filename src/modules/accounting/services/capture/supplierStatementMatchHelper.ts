/**
 * Supplier Statement Match Helper
 *
 * Pure matching logic: no DB calls, no side effects.
 * Used by supplierStatementReconService.ts.
 */
import { fmtDate } from '@/lib/fmtDate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AMOUNT_DIFF_THRESHOLD = 0.01;
export const DATE_DIFF_THRESHOLD_DAYS = 7;
export const FUZZY_AMOUNT_PCT = 0.005;
export const FUZZY_DATE_DAYS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
}

export type MismatchReason =
  | 'missing_in_isaflow'
  | 'missing_in_statement'
  | 'amount_diff'
  | 'date_diff'
  | null;

export interface MatchResult {
  invoiceId: string | null;
  confidence: number | null;
  mismatchReason: MismatchReason;
}

export interface MissingInvoice {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function dateDiffDays(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / msPerDay;
}

export function toDateStr(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return fmtDate(val);
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

export function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

export function toStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function matchLine(
  ref: string | undefined,
  debit: number | undefined,
  lineDate: string | undefined,
  invoices: InvoiceRecord[],
): MatchResult {
  // 1. Exact reference match on invoice_number
  if (ref) {
    const exact = invoices.find(
      (inv) => inv.invoiceNumber.trim().toLowerCase() === ref.trim().toLowerCase(),
    );
    if (exact) {
      const amtDiff = Math.abs((debit ?? 0) - exact.totalAmount);
      const dDiff = lineDate ? dateDiffDays(lineDate, exact.invoiceDate) : 0;
      if (amtDiff > AMOUNT_DIFF_THRESHOLD) {
        return { invoiceId: exact.id, confidence: 1.0, mismatchReason: 'amount_diff' };
      }
      if (dDiff > DATE_DIFF_THRESHOLD_DAYS) {
        return { invoiceId: exact.id, confidence: 1.0, mismatchReason: 'date_diff' };
      }
      return { invoiceId: exact.id, confidence: 1.0, mismatchReason: null };
    }
  }

  // 2. Fuzzy: amount within ±0.5% + date within ±3 days
  if (debit && debit > 0) {
    const threshold = debit * FUZZY_AMOUNT_PCT;
    const candidates = invoices.filter((inv) => Math.abs(inv.totalAmount - debit) <= threshold);
    if (lineDate) {
      const byDate = candidates.find(
        (inv) => dateDiffDays(lineDate, inv.invoiceDate) <= FUZZY_DATE_DAYS,
      );
      if (byDate) {
        const amtDiff = Math.abs(debit - byDate.totalAmount);
        const dDiff = dateDiffDays(lineDate, byDate.invoiceDate);
        if (amtDiff > AMOUNT_DIFF_THRESHOLD) {
          return { invoiceId: byDate.id, confidence: 0.85, mismatchReason: 'amount_diff' };
        }
        if (dDiff > DATE_DIFF_THRESHOLD_DAYS) {
          return { invoiceId: byDate.id, confidence: 0.85, mismatchReason: 'date_diff' };
        }
        return { invoiceId: byDate.id, confidence: 0.85, mismatchReason: null };
      }
    }
  }

  return { invoiceId: null, confidence: null, mismatchReason: 'missing_in_isaflow' };
}

export function buildMissingInvoices(
  invoices: InvoiceRecord[],
  matchedIds: Set<string>,
): MissingInvoice[] {
  return invoices
    .filter((inv) => !matchedIds.has(inv.id))
    .map((inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      totalAmount: inv.totalAmount,
    }));
}

// ---------------------------------------------------------------------------
// LineInsert + buildInserts (shared between create and rematch)
// ---------------------------------------------------------------------------

export interface ExtractedLineInput {
  date?: string;
  reference?: string;
  description?: string;
  debit?: number;
  credit?: number;
  runningBalance?: number;
}

export interface LineInsert {
  reconciliationId: string;
  lineDate: string | null;
  reference: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number | null;
  matchedInvoiceId: string | null;
  matchConfidence: number | null;
  mismatchReason: string | null;
}

export function buildInserts(
  reconId: string,
  extractedLines: ExtractedLineInput[],
  invoices: InvoiceRecord[],
): { inserts: LineInsert[]; matchedIds: Set<string>; confidences: number[] } {
  const matchedIds = new Set<string>();
  const confidences: number[] = [];
  const inserts: LineInsert[] = [];

  for (const line of extractedLines) {
    const { invoiceId, confidence, mismatchReason } = matchLine(
      line.reference,
      line.debit,
      line.date,
      invoices,
    );
    if (invoiceId) matchedIds.add(invoiceId);
    if (confidence != null) confidences.push(confidence);
    inserts.push({
      reconciliationId: reconId,
      lineDate: line.date ?? null,
      reference: line.reference ?? null,
      description: line.description ?? null,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
      runningBalance: line.runningBalance ?? null,
      matchedInvoiceId: invoiceId,
      matchConfidence: confidence,
      mismatchReason,
    });
  }

  const missing = buildMissingInvoices(invoices, matchedIds);
  for (const inv of missing) {
    inserts.push({
      reconciliationId: reconId,
      lineDate: inv.invoiceDate || null,
      reference: inv.invoiceNumber,
      description: `Invoice ${inv.invoiceNumber} in ledger but absent from statement`,
      debit: inv.totalAmount,
      credit: 0,
      runningBalance: null,
      matchedInvoiceId: inv.invoiceId,
      matchConfidence: null,
      mismatchReason: 'missing_in_statement',
    });
  }

  return { inserts, matchedIds, confidences };
}
