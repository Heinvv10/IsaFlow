/**
 * Bank Match Candidates API
 * GET /api/accounting/bank-match-candidates?bankTransactionId=<uuid>
 *
 * Smart matching strategy:
 * 1. Extract entity name from description → filter to that customer/supplier
 * 2. Direction-based: receipts → customer invoices, payments → supplier invoices/POs
 * 3. Invoice reference detection: if description contains "INV-00478" → boost that invoice
 * 4. Exact amount match on outstanding balance → highest score
 * 5. Multi-invoice combo: find 2-3 invoices whose balances sum to the payment amount
 * 6. Journal lines as fallback
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

/* ── Scoring helpers ──────────────────────────────────────────────────────── */

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

/* ── Entity extraction ────────────────────────────────────────────────────── */

const DESC_PREFIXES = [
  'EFT REC', 'EFT PMT', 'EFT PAYMENT', 'EFT RECEIPT',
  'PAYMENT TO', 'PAYMENT FROM', 'PMT TO', 'PMT FROM',
  'DEBIT ORDER', 'DEBI ORDER', 'STOP ORDER',
  'MAGTAPE', 'INTERNET TRF', 'CASH DEPOSIT',
];

function extractEntityName(description: string): string {
  let cleaned = description.toUpperCase().trim();
  for (const prefix of DESC_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }
  cleaned = cleaned.replace(/\s+\d{4}\/\d{2}$/, '').trim();
  cleaned = cleaned.replace(/\s+\d{6,}$/, '').trim();
  cleaned = cleaned.replace(/\s*\(PTY\)\s*(LTD)?/gi, '').trim();
  cleaned = cleaned.replace(/\s*\(SOC\)/gi, '').trim();
  return cleaned;
}

/**
 * Extract invoice reference numbers from description/reference.
 * Matches patterns like INV-00478, SINV-00548, INV00478, #478, etc.
 */
function extractInvoiceRefs(text: string): string[] {
  if (!text) return [];
  const refs: string[] = [];
  // Match INV-00478, SINV-00548, INV00478
  const invPattern = /(?:S?INV)[- ]?(\d{3,})/gi;
  let m: RegExpExecArray | null;
  while ((m = invPattern.exec(text)) !== null) {
    refs.push(m[1]!);
  }
  // Match PO-00123, PO00123
  const poPattern = /PO[- ]?(\d{3,})/gi;
  while ((m = poPattern.exec(text)) !== null) {
    refs.push(m[1]!);
  }
  return refs;
}

function entityNameMatches(entityName: string, extractedName: string): boolean {
  if (!entityName || !extractedName) return false;
  const entityWords = entityName.toUpperCase().split(/\W+/).filter(w => w.length > 2);
  const extractedWords = new Set(extractedName.toUpperCase().split(/\W+/).filter(w => w.length > 2));
  return entityWords.some(w => extractedWords.has(w));
}

/** Check if an invoice number matches any extracted references */
function invoiceRefMatches(invoiceNumber: string, refs: string[]): boolean {
  if (!invoiceNumber || refs.length === 0) return false;
  // Extract just the digits from the invoice number
  const invDigits = invoiceNumber.replace(/\D/g, '');
  return refs.some(ref => invDigits === ref || invDigits.endsWith(ref));
}

/* ── Multi-invoice combo detection ────────────────────────────────────────── */

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  entityName: string;
  balance: number;
  date: string;
  type: 'supplier_invoice' | 'customer_invoice';
}

/**
 * Find combinations of 2-3 invoices whose balances sum to the target amount.
 * Only checks invoices from the same entity. Tolerance: R0.01.
 */
function findInvoiceCombos(invoices: InvoiceRow[], targetAmount: number): InvoiceRow[][] {
  const combos: InvoiceRow[][] = [];
  const tolerance = 0.01;

  // 2-invoice combos
  for (let i = 0; i < invoices.length && combos.length < 3; i++) {
    for (let j = i + 1; j < invoices.length && combos.length < 3; j++) {
      const sum = invoices[i]!.balance + invoices[j]!.balance;
      if (Math.abs(sum - targetAmount) <= tolerance) {
        combos.push([invoices[i]!, invoices[j]!]);
      }
    }
  }

  // 3-invoice combos (only if no 2-combos found)
  if (combos.length === 0) {
    for (let i = 0; i < invoices.length && combos.length < 2; i++) {
      for (let j = i + 1; j < invoices.length && combos.length < 2; j++) {
        for (let k = j + 1; k < invoices.length && combos.length < 2; k++) {
          const sum = invoices[i]!.balance + invoices[j]!.balance + invoices[k]!.balance;
          if (Math.abs(sum - targetAmount) <= tolerance) {
            combos.push([invoices[i]!, invoices[j]!, invoices[k]!]);
          }
        }
      }
    }
  }

  return combos;
}

/* ── Handler ──────────────────────────────────────────────────────────────── */

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
    const txRef = String(tx.reference ?? '');
    const absAmount = Math.abs(txAmount);

    const extractedEntity = extractEntityName(txDesc);
    const invoiceRefs = extractInvoiceRefs(`${txDesc} ${txRef}`);
    const isReceipt = txAmount > 0;

    const candidates: MatchCandidate[] = [];

    // ── 1. Supplier invoices (payments only) ────────────────────────────────
    if (!isReceipt) {
      const allRows = (await sql`
        SELECT si.id, si.invoice_number, COALESCE(s.company_name, s.name) AS supplier_name,
               si.total_amount, si.invoice_date
        FROM supplier_invoices si
        JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.status IN ('approved', 'partially_paid')
          AND si.company_id = ${companyId}
        ORDER BY ABS(si.total_amount - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      let rows = allRows;
      if (extractedEntity) {
        const filtered = allRows.filter((r: Row) =>
          entityNameMatches(String(r.supplier_name), extractedEntity));
        if (filtered.length > 0) rows = filtered;
      }

      // Collect for combo detection
      const comboPool: InvoiceRow[] = [];

      for (const row of rows.slice(0, 20)) {
        const invNum = String(row.invoice_number);
        const label = `${String(row.supplier_name)} — Inv ${invNum}`;
        const candAmount = Number(row.total_amount);
        const candDate = fmtDate(row.invoice_date);

        let score = scoreAmount(txAmount, candAmount)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);

        let matchReason: string | undefined;

        // Bonus: invoice reference in bank description
        if (invoiceRefMatches(invNum, invoiceRefs)) {
          score += 30;
          matchReason = `Reference ${invNum} found in description`;
        }

        // Bonus: exact amount match
        if (Math.abs(candAmount - absAmount) < 0.01) {
          matchReason = matchReason
            ? `${matchReason} + exact amount`
            : 'Exact amount match';
        }

        candidates.push({
          type: 'supplier_invoice', id: String(row.id),
          label, amount: candAmount, date: candDate, score, matchReason,
        });

        comboPool.push({
          id: String(row.id), invoiceNumber: invNum,
          entityName: String(row.supplier_name),
          balance: candAmount, date: candDate,
          type: 'supplier_invoice',
        });
      }

      // Multi-invoice combos
      const combos = findInvoiceCombos(comboPool, absAmount);
      for (const combo of combos) {
        const invNums = combo.map(c => c.invoiceNumber).join(' + ');
        const label = `${combo[0]!.entityName} — ${combo.length} invoices (${invNums})`;
        candidates.push({
          type: 'supplier_invoice',
          id: combo.map(c => c.id).join(','),
          label,
          amount: combo.reduce((sum, c) => sum + c.balance, 0),
          date: combo[0]!.date,
          score: 95,
          matchReason: `${combo.length} invoices sum to exact payment amount`,
        });
      }
    }

    // ── 2. Customer invoices (receipts only) ─────────────────────────────────
    if (isReceipt) {
      const allRows = (await sql`
        SELECT ci.id, ci.invoice_number, c.name AS customer_name,
               ci.total_amount, ci.invoice_date, ci.amount_paid
        FROM customer_invoices ci
        JOIN customers c ON c.id = ci.customer_id
        WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
          AND ci.company_id = ${companyId}
        ORDER BY ABS(ci.total_amount - ci.amount_paid - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      let rows = allRows;
      if (extractedEntity) {
        const filtered = allRows.filter((r: Row) =>
          entityNameMatches(String(r.customer_name), extractedEntity));
        if (filtered.length > 0) rows = filtered;
      }

      const comboPool: InvoiceRow[] = [];

      for (const row of rows.slice(0, 20)) {
        const invNum = String(row.invoice_number);
        const label = `${String(row.customer_name)} — Inv ${invNum}`;
        const balance = Number(row.total_amount) - Number(row.amount_paid || 0);
        const candDate = fmtDate(row.invoice_date);

        let score = scoreAmount(txAmount, balance)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);

        let matchReason: string | undefined;

        if (invoiceRefMatches(invNum, invoiceRefs)) {
          score += 30;
          matchReason = `Reference ${invNum} found in description`;
        }

        if (Math.abs(balance - absAmount) < 0.01) {
          matchReason = matchReason
            ? `${matchReason} + exact amount`
            : 'Exact amount match';
        }

        candidates.push({
          type: 'customer_invoice', id: String(row.id),
          label, amount: balance, date: candDate, score, matchReason,
        });

        comboPool.push({
          id: String(row.id), invoiceNumber: invNum,
          entityName: String(row.customer_name),
          balance, date: candDate,
          type: 'customer_invoice',
        });
      }

      // Multi-invoice combos
      const combos = findInvoiceCombos(comboPool, absAmount);
      for (const combo of combos) {
        const invNums = combo.map(c => c.invoiceNumber).join(' + ');
        const label = `${combo[0]!.entityName} — ${combo.length} invoices (${invNums})`;
        candidates.push({
          type: 'customer_invoice',
          id: combo.map(c => c.id).join(','),
          label,
          amount: combo.reduce((sum, c) => sum + c.balance, 0),
          date: combo[0]!.date,
          score: 95,
          matchReason: `${combo.length} invoices sum to exact receipt amount`,
        });
      }
    }

    // ── 3. Purchase orders (payments only) ───────────────────────────────────
    if (!isReceipt) {
      const allRows = (await sql`
        SELECT po.id, po.po_number, COALESCE(s.company_name, s.name) AS supplier_name,
               po.total, po.created_at
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.status IN ('approved', 'partially_paid')
          AND po.company_id = ${companyId}
        ORDER BY ABS(po.total - ${absAmount}::NUMERIC) ASC
        LIMIT 50
      `) as Row[];

      let rows = allRows;
      if (extractedEntity) {
        const filtered = allRows.filter((r: Row) =>
          entityNameMatches(String(r.supplier_name), extractedEntity));
        if (filtered.length > 0) rows = filtered;
      }

      for (const row of rows.slice(0, 20)) {
        const poNum = String(row.po_number);
        const label = `${String(row.supplier_name)} — PO ${poNum}`;
        const candAmount = Number(row.total);
        const candDate = fmtDate(row.created_at);

        let score = scoreAmount(txAmount, candAmount)
          + scoreDate(txDate, candDate)
          + scoreDescription(txDesc, label);

        let matchReason: string | undefined;

        if (invoiceRefMatches(poNum, invoiceRefs)) {
          score += 30;
          matchReason = `Reference ${poNum} found in description`;
        }

        if (Math.abs(candAmount - absAmount) < 0.01) {
          matchReason = matchReason
            ? `${matchReason} + exact amount`
            : 'Exact amount match';
        }

        candidates.push({
          type: 'purchase_order', id: String(row.id),
          label, amount: candAmount, date: candDate, score, matchReason,
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

      let matchReason: string | undefined;
      if (Math.abs(lineNet - txAmount) < 0.01) {
        matchReason = 'Exact amount match';
      }

      candidates.push({
        type: 'journal_line', id: String(row.id),
        label, amount: lineNet, date: candDate, score, matchReason,
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    log.info('Fetched bank match candidates', {
      bankTransactionId,
      extractedEntity: extractedEntity || '(none)',
      invoiceRefs: invoiceRefs.length > 0 ? invoiceRefs.join(',') : '(none)',
      count: candidates.length,
    }, 'accounting-api');

    return apiResponse.success(res, { candidates });
  } catch (err) {
    log.error('Failed to fetch bank match candidates', { bankTransactionId, error: err }, 'accounting-api');
    return apiResponse.internalError(res, err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
