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

import { sql } from '@/lib/neon';
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
 *
 * `poolConsidered` and `scoredTotal` are reported alongside the shortlist so a
 * caller can state its own completeness honestly: five candidates out of fifty
 * open invoices and five out of five are very different answers, and the
 * shortlist alone cannot tell them apart. Existing callers destructure
 * `{ candidates }` and are unaffected.
 */
export async function getReceiptMatchCandidates(
  bankTransactionId: string,
  companyId: string,
): Promise<{ candidates: MatchCandidate[]; poolConsidered: number; scoredTotal: number }> {
  const tx = await fetchBankTransaction(bankTransactionId, companyId);
  if (!tx || tx.amount <= 0) return { candidates: [], poolConsidered: 0, scoredTotal: 0 };

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

  // poolConsidered is the pool AFTER the entity narrowing, because that is the
  // set every returned score was computed against. Reporting the pre-narrowing
  // count would overstate what the shortlist is a shortlist OF.
  return { candidates: top, poolConsidered: filtered.length, scoredTotal: scored.length };
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

// `confirmReceiptMatch` — the write half — moved to `receiptMatchConfirmService.ts`
// when it was widened from one invoice to many. This file was already 358 lines
// against a 300-line cap, and scoring a shortlist and posting a journal share
// nothing but a domain.
