/**
 * Receipt → Invoice Auto-Match (PRD-06 Phase 4)
 *
 * Scored shortlist for incoming customer receipts. Scoring signals:
 *   1. payment_reference_exact  — invoice_number appears verbatim in
 *      bank description/reference     (+40 score)
 *   2. payment_reference_partial — trigram similarity ≥ 0.4           (+20 score)
 *   3. portal_view_boost         — invoice viewed in last 30 days     (+10 score)
 *   4. amount delta              — via scoreAmount()                  (0–50)
 *   5. date delta                — via scoreDate()                    (0–30)
 *   6. description overlap       — via scoreDescription()             (0–20)
 *
 * Max theoretical score ≈ 170; anything ≥ 100 is "auto-match confidence" and
 * typically lands at rank 1. Output is the top 5 candidates sorted desc.
 *
 * This service is company-scoped. Never returns candidates across tenants.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { MatchCandidate, ReceiptMatchSignals } from '@/modules/accounting/types/bank-match.types';
import {
  scoreAmount,
  scoreDate,
  scoreDescription,
  fmtDate,
  extractEntityName,
  extractInvoiceRefs,
  entityNameMatches,
  fetchBankTransaction,
} from '@/modules/accounting/services/bank/bankMatchCandidatesService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

const REFERENCE_EXACT_BONUS = 40;
const REFERENCE_PARTIAL_BONUS = 20;
const PORTAL_VIEW_BOOST_POINTS = 10;
const PORTAL_VIEW_LOOKBACK_DAYS = 30;
const TRIGRAM_THRESHOLD = 0.4;
const TOP_N = 5;

interface InvoiceCandidateRow extends DbRow {
  id: string;
  invoice_number: string;
  customer_name: string;
  total_amount: string | number;
  amount_paid: string | number;
  invoice_date: string | Date;
  viewed_within_30d: boolean;
  trigram_similarity: number | null;
}

/**
 * Top-N scored customer-invoice candidates for a receipt (positive bank tx).
 * Always returns [] for non-receipt transactions or unknown tx ids.
 */
export async function getReceiptMatchCandidates(
  bankTransactionId: string,
  companyId: string,
): Promise<{ candidates: MatchCandidate[] }> {
  const tx = await fetchBankTransaction(bankTransactionId, companyId);
  if (!tx || tx.amount <= 0) return { candidates: [] };

  const { amount: txAmount, transactionDate: txDate, description: txDesc, reference: txRef } = tx;
  const absAmount = Math.abs(txAmount);
  const combinedRefText = `${txDesc} ${txRef}`.trim();
  const invoiceRefs = extractInvoiceRefs(combinedRefText);
  const primaryRef = invoiceRefs[0] ?? '';
  const extractedEntity = extractEntityName(txDesc);

  const rows = await fetchCandidatePool(companyId, absAmount, primaryRef);
  const filtered = narrowByEntity(rows, extractedEntity);

  const scored: MatchCandidate[] = filtered.map((row) =>
    scoreCandidate(row, txAmount, txDate, txDesc, invoiceRefs),
  );

  const top = scored.sort((a, b) => b.score - a.score).slice(0, TOP_N);

  log.info('Scored receipt-match candidates', {
    bankTransactionId,
    poolSize: rows.length,
    narrowedTo: filtered.length,
    returned: top.length,
    topScore: top[0]?.score ?? 0,
  }, 'accounting-api');

  return { candidates: top };
}

/**
 * Pool of open customer invoices for this company. Trigram similarity is
 * computed in SQL against the primary extracted reference (if any) so we
 * can rank fuzzy hits cheaply. Cap at 50 rows to bound work.
 */
async function fetchCandidatePool(
  companyId: string,
  absAmount: number,
  primaryRef: string,
): Promise<InvoiceCandidateRow[]> {
  const lookbackInterval = `${PORTAL_VIEW_LOOKBACK_DAYS} days`;

  const rows = (await sql`
    SELECT ci.id,
           ci.invoice_number,
           c.name AS customer_name,
           ci.total_amount,
           ci.amount_paid,
           ci.invoice_date,
           CASE WHEN ${primaryRef} = '' THEN NULL
                ELSE similarity(ci.invoice_number, ${primaryRef})
           END AS trigram_similarity,
           EXISTS (
             SELECT 1 FROM customer_invoice_views v
             WHERE v.customer_invoice_id = ci.id
               AND v.company_id = ci.company_id
               AND v.viewed_at >= NOW() - ${lookbackInterval}::INTERVAL
           ) AS viewed_within_30d
    FROM customer_invoices ci
    JOIN customers c ON c.id = ci.customer_id
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
      AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) > 0.01
    ORDER BY ABS((ci.total_amount - COALESCE(ci.amount_paid, 0)) - ${absAmount}::NUMERIC) ASC
    LIMIT 50
  `) as InvoiceCandidateRow[];

  return rows;
}

function narrowByEntity(rows: InvoiceCandidateRow[], extractedEntity: string): InvoiceCandidateRow[] {
  if (!extractedEntity) return rows;
  const filtered = rows.filter((r) => entityNameMatches(String(r.customer_name), extractedEntity));
  return filtered.length > 0 ? filtered : rows;
}

function scoreCandidate(
  row: InvoiceCandidateRow,
  txAmount: number,
  txDate: string,
  txDesc: string,
  invoiceRefs: string[],
): MatchCandidate {
  const invoiceNumber = String(row.invoice_number);
  const customerName = String(row.customer_name);
  const label = `${customerName} — Inv ${invoiceNumber}`;
  const balance = Number(row.total_amount) - Number(row.amount_paid ?? 0);
  const candDate = fmtDate(row.invoice_date);

  const trigram = Number(row.trigram_similarity ?? 0);
  const viewedWithin30d = Boolean(row.viewed_within_30d);

  const exactHit = isExactReferenceHit(invoiceNumber, invoiceRefs);
  const partialHit = !exactHit && trigram >= TRIGRAM_THRESHOLD;

  const referenceScore = exactHit
    ? REFERENCE_EXACT_BONUS
    : partialHit
      ? REFERENCE_PARTIAL_BONUS
      : 0;

  const portalViewScore = viewedWithin30d ? PORTAL_VIEW_BOOST_POINTS : 0;
  const amountScore = scoreAmount(txAmount, balance);
  const dateScore = scoreDate(txDate, candDate);
  const descScore = scoreDescription(txDesc, label);

  const score = referenceScore + portalViewScore + amountScore + dateScore + descScore;

  const signals: ReceiptMatchSignals = {
    paymentReferenceExact: exactHit,
    paymentReferencePartial: partialHit,
    portalViewBoost: portalViewScore > 0 ? 0.1 : 0,
    trigramSimilarity: trigram > 0 ? Number(trigram.toFixed(3)) : undefined,
    scoreBreakdown: {
      reference: referenceScore,
      portalView: portalViewScore,
      amount: amountScore,
      date: dateScore,
      description: descScore,
    },
  };

  const matchReason = buildMatchReason(exactHit, partialHit, viewedWithin30d, balance, txAmount);

  return {
    type: 'customer_invoice',
    id: String(row.id),
    label,
    amount: balance,
    date: candDate,
    score,
    matchReason,
    signals,
  };
}

function isExactReferenceHit(invoiceNumber: string, refs: string[]): boolean {
  if (refs.length === 0) return false;
  const invUpper = invoiceNumber.toUpperCase();
  const invDigits = invoiceNumber.replace(/\D/g, '');
  return refs.some((ref) => {
    if (!ref) return false;
    const refUpper = ref.toUpperCase();
    if (invUpper === refUpper) return true;
    if (invDigits && (invDigits === ref || invDigits.endsWith(ref))) return true;
    return false;
  });
}

function buildMatchReason(
  exactHit: boolean,
  partialHit: boolean,
  viewedWithin30d: boolean,
  balance: number,
  txAmount: number,
): string | undefined {
  const parts: string[] = [];
  if (exactHit) parts.push('Exact INV reference');
  else if (partialHit) parts.push('Fuzzy INV reference');
  if (Math.abs(balance - Math.abs(txAmount)) < 0.01) parts.push('exact amount');
  if (viewedWithin30d) parts.push('portal viewed <30d');
  return parts.length > 0 ? parts.join(' + ') : undefined;
}

// ── Confirm allocation ────────────────────────────────────────────────────────

export interface ConfirmReceiptMatchResult {
  journalEntryId: string;
  customerPaymentId: string | null;
  invoiceId: string;
  invoiceStatus: string;
  amountApplied: number;
  newBalance: number;
}

/**
 * Allocates a bank receipt to a customer invoice. Called by the "Confirm"
 * action in the AR receipt-match UI.
 *
 * Steps (all within a single logical flow):
 *   1. Resolve the invoice's customer_id (so allocateTransaction can create a
 *      customer_payments row).
 *   2. Delegate to bankAllocationService.allocateTransaction(allocType='customer')
 *      — posts the DR Bank / CR AR journal, flips the bank_transaction to
 *      'allocated', and inserts a confirmed customer_payments row.
 *   3. Attach the resulting customer_payment to the invoice via
 *      customer_payment_allocations AND bump customer_invoices.amount_paid /
 *      status atomically.
 *
 * The invoice-balance update lives here (not in allocateTransaction) because
 * allocateTransaction is the generic bank → GL flow used by non-invoice
 * allocations too. Keeping this wrapper scoped to PRD-06 Phase 4 means no
 * behaviour change for existing bank-rec callers.
 */
export async function confirmReceiptMatch(
  companyId: string,
  params: { bankTxId: string; customerInvoiceId: string; amount: number; userId: string },
): Promise<ConfirmReceiptMatchResult> {
  const { bankTxId, customerInvoiceId, amount, userId } = params;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const invRows = (await sql`
    SELECT ci.id, ci.invoice_number, ci.total_amount, ci.amount_paid, ci.status,
           COALESCE(ci.client_id, ci.customer_id) AS customer_id
    FROM customer_invoices ci
    WHERE ci.id = ${customerInvoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (invRows.length === 0) {
    throw new Error(`Customer invoice ${customerInvoiceId} not found`);
  }
  const invoice = invRows[0]!;
  const customerId = invoice.customer_id ? String(invoice.customer_id) : null;
  if (!customerId) {
    throw new Error(`Customer invoice ${customerInvoiceId} has no customer link`);
  }

  const invoiceTotal = Number(invoice.total_amount);
  const invoicePaid = Number(invoice.amount_paid ?? 0);
  const balanceBefore = invoiceTotal - invoicePaid;
  if (amount > balanceBefore + 0.01) {
    throw new Error(
      `amount R${amount.toFixed(2)} exceeds outstanding balance R${balanceBefore.toFixed(2)}`,
    );
  }

  const { journalEntryId } = await allocateTransaction(
    companyId,
    bankTxId,
    null,
    userId,
    `Receipt allocated to ${String(invoice.invoice_number)}`,
    'customer',
    customerId,
    undefined,
    undefined,
    undefined,
    undefined,
    customerInvoiceId,
  );

  const paymentRows = (await sql`
    SELECT id FROM customer_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalEntryId}::UUID
    ORDER BY created_at DESC LIMIT 1
  `) as DbRow[];
  const customerPaymentId = paymentRows.length > 0 ? String(paymentRows[0]!.id) : null;

  const { invoiceStatus, newBalance } = await withTransaction(async (tx) => {
    if (customerPaymentId) {
      await tx`
        INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
        VALUES (${customerPaymentId}::UUID, ${customerInvoiceId}::UUID, ${amount})
      `;
    }
    await tx`
      UPDATE customer_invoices
      SET amount_paid = COALESCE(amount_paid, 0) + ${amount},
          status = CASE
            WHEN (total_amount - (COALESCE(amount_paid, 0) + ${amount})) <= 0.01 THEN 'paid'
            WHEN (COALESCE(amount_paid, 0) + ${amount}) > 0 THEN 'partially_paid'
            ELSE status
          END,
          paid_at = CASE
            WHEN (total_amount - (COALESCE(amount_paid, 0) + ${amount})) <= 0.01 THEN NOW()
            ELSE paid_at
          END,
          updated_at = NOW()
      WHERE id = ${customerInvoiceId}::UUID AND company_id = ${companyId}::UUID
    `;
    const after = (await tx`
      SELECT status, total_amount, amount_paid
      FROM customer_invoices
      WHERE id = ${customerInvoiceId}::UUID
    `) as DbRow[];
    const row = after[0]!;
    return {
      invoiceStatus: String(row.status),
      newBalance: Number(row.total_amount) - Number(row.amount_paid ?? 0),
    };
  });

  log.info('Confirmed receipt-match allocation', {
    bankTxId,
    customerInvoiceId,
    journalEntryId,
    customerPaymentId,
    amount,
    invoiceStatus,
  }, 'accounting-api');

  return {
    journalEntryId,
    customerPaymentId,
    invoiceId: customerInvoiceId,
    invoiceStatus,
    amountApplied: amount,
    newBalance,
  };
}
