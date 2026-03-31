/**
 * Bank Match Candidates API
 * GET /api/accounting/bank-match-candidates?bankTransactionId=<uuid>
 * Returns scored candidate matches from supplier invoices, customer invoices,
 * purchase orders, and GL journal lines.
 *
 * Smart entity matching: extracts supplier/customer name from the transaction
 * description (e.g. "EFT REC VUMATEL HOLDINGS" → Vumatel Holdings) and only
 * returns invoices/POs for that entity. Falls back to showing all if no match.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { MatchCandidate } from '@/modules/accounting/types/bank-match.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** Score 0–50: how close the candidate amount is to the transaction amount */
function scoreAmount(txAmount: number, candidateAmount: number): number {
  const diff = Math.abs(Math.abs(txAmount) - Math.abs(candidateAmount));
  if (diff === 0) return 50;
  if (diff < 0.01) return 48;
  if (diff < 1) return 40;
  if (diff < 10) return 30;
  if (diff < 100) return 20;
  if (diff < 1000) return 10;
  return 0;
}

/** Score 0–30: how close the candidate date is to the transaction date */
function scoreDate(txDate: string, candidateDate: string): number {
  const tx = new Date(txDate).getTime();
  const cand = new Date(candidateDate).getTime();
  const diffDays = Math.abs(tx - cand) / (1000 * 60 * 60 * 24);
  if (diffDays === 0) return 30;
  if (diffDays <= 1) return 28;
  if (diffDays <= 3) return 24;
  if (diffDays <= 7) return 20;
  if (diffDays <= 14) return 14;
  if (diffDays <= 30) return 8;
  if (diffDays <= 60) return 4;
  return 0;
}

/** Score 0–20: simple word-overlap between description strings */
function scoreDescription(txDesc: string, candidateLabel: string): number {
  if (!txDesc || !candidateLabel) return 0;
  const txWords = new Set(txDesc.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const candWords = candidateLabel.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  if (txWords.size === 0 || candWords.length === 0) return 0;
  const matches = candWords.filter(w => txWords.has(w)).length;
  const ratio = matches / Math.max(txWords.size, candWords.length);
  return Math.round(ratio * 20);
}

function fmtDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().split('T')[0]!;
  return val ? String(val).split('T')[0]! : '';
}

/**
 * Strip common bank description prefixes to extract the entity name.
 * e.g. "EFT REC VUMATEL HOLDINGS" → "VUMATEL HOLDINGS"
 *      "EFT PMT BIDVEST CLEANING" → "BIDVEST CLEANING"
 *      "DEBIT ORDER SARS" → "SARS"
 */
const DESC_PREFIXES = [
  'EFT REC', 'EFT PMT', 'EFT PAYMENT', 'EFT RECEIPT',
  'PAYMENT TO', 'PAYMENT FROM', 'PMT TO', 'PMT FROM',
  'DEBIT ORDER', 'DEBI ORDER', 'STOP ORDER',
  'MAGTAPE', 'INTERNET TRF', 'CASH DEPOSIT',
];

function extractEntityName(description: string): string {
  let cleaned = description.toUpperCase().trim();
  // Strip prefixes
  for (const prefix of DESC_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }
  // Strip trailing date patterns like "2027/03" or reference numbers
  cleaned = cleaned.replace(/\s+\d{4}\/\d{2}$/, '').trim();
  cleaned = cleaned.replace(/\s+\d{6,}$/, '').trim();
  // Strip common suffixes like (PTY) LTD, (SOC)
  cleaned = cleaned.replace(/\s*\(PTY\)\s*(LTD)?/gi, '').trim();
  cleaned = cleaned.replace(/\s*\(SOC\)/gi, '').trim();
  return cleaned;
}

/**
 * Check if a customer/supplier name fuzzy-matches the extracted entity name.
 * Uses word overlap — if any significant word from the entity appears in the name, it's a match.
 */
function entityNameMatches(entityName: string, extractedName: string): boolean {
  if (!entityName || !extractedName) return false;
  const entityWords = entityName.toUpperCase().split(/\W+/).filter(w => w.length > 2);
  const extractedWords = new Set(extractedName.toUpperCase().split(/\W+/).filter(w => w.length > 2));
  // At least one significant word must match
  return entityWords.some(w => extractedWords.has(w));
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { bankTransactionId } = req.query;
  if (!bankTransactionId || typeof bankTransactionId !== 'string') {
    return apiResponse.badRequest(res, 'bankTransactionId query param is required');
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    // Fetch the bank transaction to get amount, date, description
    const txRows = (await sql`
      SELECT id, amount, transaction_date, description, reference
      FROM bank_transactions
      WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    `) as Row[];

    if (txRows.length === 0) {
      return apiResponse.notFound(res, 'Bank transaction', bankTransactionId);
    }

    const tx = txRows[0]!;
    const txAmount = Number(tx.amount);
    const txDate = fmtDate(tx.transaction_date);
    const txDesc = String(tx.description ?? tx.reference ?? '');
    const absAmount = Math.abs(txAmount);

    // Extract entity name from description for targeted filtering
    const extractedEntity = extractEntityName(txDesc);

    // Direction-based logic:
    // Positive amount (receipt/deposit) → show customer invoices only
    // Negative amount (payment/debit)   → show supplier invoices & POs only
    // Journal lines always shown as fallback
    const isReceipt = txAmount > 0;

    const candidates: MatchCandidate[] = [];

    // ── 1. Supplier invoices (payments only) ────────────────────────────────
    if (!isReceipt) {
      const allSupplierInvRows = (await sql`
        SELECT si.id, si.invoice_number, COALESCE(s.company_name, s.name) AS supplier_name,
               si.total_amount, si.invoice_date
        FROM supplier_invoices si
        JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.status IN ('approved', 'partially_paid')
          AND si.company_id = ${companyId}
        ORDER BY ABS(si.total_amount - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      // Filter to matched entity if possible
      let supplierInvRows = allSupplierInvRows;
      if (extractedEntity) {
        const filtered = allSupplierInvRows.filter((r: Row) =>
          entityNameMatches(String(r.supplier_name), extractedEntity));
        if (filtered.length > 0) supplierInvRows = filtered;
      }

      for (const row of supplierInvRows.slice(0, 20)) {
        const label = `${String(row.supplier_name)} — Inv ${String(row.invoice_number)}`;
        const candAmount = Number(row.total_amount);
        const candDate = fmtDate(row.invoice_date);
        const score = scoreAmount(txAmount, candAmount)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);
        candidates.push({
          type: 'supplier_invoice',
          id: String(row.id),
          label,
          amount: candAmount,
          date: candDate,
          score,
        });
      }
    }

    // ── 2. Customer invoices (receipts only) ─────────────────────────────────
    if (isReceipt) {
      const allCustInvRows = (await sql`
        SELECT ci.id, ci.invoice_number, c.name AS customer_name,
               ci.total_amount, ci.invoice_date, ci.amount_paid
        FROM customer_invoices ci
        JOIN customers c ON c.id = ci.customer_id
        WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND ci.company_id = ${companyId}
        ORDER BY ABS(ci.total_amount - ci.amount_paid - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      let custInvRows = allCustInvRows;
      if (extractedEntity) {
        const filtered = allCustInvRows.filter((r: Row) =>
          entityNameMatches(String(r.customer_name), extractedEntity));
        if (filtered.length > 0) custInvRows = filtered;
      }

      for (const row of custInvRows.slice(0, 20)) {
        const label = `${String(row.customer_name)} — Inv ${String(row.invoice_number)}`;
        const balance = Number(row.total_amount) - Number(row.amount_paid || 0);
        const candDate = fmtDate(row.invoice_date);
        const score = scoreAmount(txAmount, balance)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);
        candidates.push({
          type: 'customer_invoice',
          id: String(row.id),
          label,
          amount: balance,
          date: candDate,
          score,
        });
      }
    }

    // ── 3. Purchase orders (payments only) ───────────────────────────────────
    if (!isReceipt) {
      const allPoRows = (await sql`
        SELECT po.id, po.po_number, COALESCE(s.company_name, s.name) AS supplier_name,
               po.total, po.created_at
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.status IN ('approved', 'partially_paid')
          AND po.company_id = ${companyId}
        ORDER BY ABS(po.total - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      let poRows = allPoRows;
      if (extractedEntity) {
        const filtered = allPoRows.filter((r: Row) =>
          entityNameMatches(String(r.supplier_name), extractedEntity));
        if (filtered.length > 0) poRows = filtered;
      }

      for (const row of poRows.slice(0, 20)) {
        const label = `${String(row.supplier_name)} — PO ${String(row.po_number)}`;
        const candAmount = Number(row.total);
        const candDate = fmtDate(row.created_at);
        const score = scoreAmount(txAmount, candAmount)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);
        candidates.push({
          type: 'purchase_order',
          id: String(row.id),
          label,
          amount: candAmount,
          date: candDate,
          score,
        });
      }
    }

    // ── 4. GL journal lines ──────────────────────────────────────────────────
    const jlRows = (await sql`
      SELECT jl.id, jl.description, jl.debit, jl.credit, je.entry_date
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL
        )
      ORDER BY ABS((jl.debit - jl.credit) - ${txAmount}::NUMERIC) ASC
      LIMIT 20
    `) as Row[];

    for (const row of jlRows) {
      const lineNet = Number(row.debit) - Number(row.credit);
      const label = String(row.description ?? 'Journal line');
      const candDate = fmtDate(row.entry_date);
      const score = scoreAmount(txAmount, lineNet)
        + scoreDate(txDate, candDate)
        + scoreDescription(txDesc, label);
      candidates.push({
        type: 'journal_line',
        id: String(row.id),
        label,
        amount: lineNet,
        date: candDate,
        score,
      });
    }

    // Sort all candidates by score descending
    candidates.sort((a, b) => b.score - a.score);

    log.info('Fetched bank match candidates', {
      bankTransactionId,
      extractedEntity: extractedEntity || '(none)',
      count: candidates.length,
    }, 'accounting-api');

    return apiResponse.success(res, { candidates });
  } catch (err) {
    log.error('Failed to fetch bank match candidates', { bankTransactionId, error: err }, 'accounting-api');
    return apiResponse.internalError(res, err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
