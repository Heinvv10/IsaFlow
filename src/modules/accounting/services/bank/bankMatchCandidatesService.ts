/**
 * Bank Match Candidates Service
 * Scoring helpers, entity extraction, combo detection, and main orchestration.
 * DB queries live in bankMatchDbQueries.ts.
 */

import { log } from '@/lib/logger';
import type { MatchCandidate } from '@/modules/accounting/types/bank-match.types';
import {
  fetchBankTransaction,
  fetchSupplierInvoiceCandidates,
  fetchCustomerInvoiceCandidates,
  fetchPurchaseOrderCandidates,
  fetchJournalLineCandidates,
} from './bankMatchDbQueries';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';

// ── Re-export fetchBankTransaction for the API route ─────────────────────────
export { fetchBankTransaction } from './bankMatchDbQueries';

// ── Scoring helpers ───────────────────────────────────────────────────────────

export function scoreAmount(txAmount: number, candidateAmount: number): number {
  const diff = Math.abs(Math.abs(txAmount) - Math.abs(candidateAmount));
  if (diff === 0) return 50;
  if (diff < 0.01) return 48;
  if (diff < 1) return 40;
  if (diff < 10) return 30;
  if (diff < 100) return 20;
  if (diff < 1000) return 10;
  return 0;
}

export function scoreDate(txDate: string, candidateDate: string): number {
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

export function scoreDescription(txDesc: string, candidateLabel: string): number {
  if (!txDesc || !candidateLabel) return 0;
  const txWords = new Set(txDesc.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const candWords = candidateLabel.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  if (txWords.size === 0 || candWords.length === 0) return 0;
  const matches = candWords.filter(w => txWords.has(w)).length;
  const ratio = matches / Math.max(txWords.size, candWords.length);
  return Math.round(ratio * 20);
}

export { fmtDate } from '@/lib/fmtDate';

// ── Entity extraction ─────────────────────────────────────────────────────────

const DESC_PREFIXES = [
  'EFT REC', 'EFT PMT', 'EFT PAYMENT', 'EFT RECEIPT',
  'PAYMENT TO', 'PAYMENT FROM', 'PMT TO', 'PMT FROM',
  'DEBIT ORDER', 'DEBI ORDER', 'STOP ORDER',
  'MAGTAPE', 'INTERNET TRF', 'CASH DEPOSIT',
];

export function extractEntityName(description: string): string {
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

export function extractInvoiceRefs(text: string): string[] {
  if (!text) return [];
  const refs: string[] = [];
  const invPattern = /(?:S?INV)[- ]?(\d{3,})/gi;
  let m: RegExpExecArray | null;
  while ((m = invPattern.exec(text)) !== null) refs.push(m[1]!);
  const poPattern = /PO[- ]?(\d{3,})/gi;
  while ((m = poPattern.exec(text)) !== null) refs.push(m[1]!);
  return refs;
}

export function entityNameMatches(entityName: string, extractedName: string): boolean {
  if (!entityName || !extractedName) return false;
  const entityWords = entityName.toUpperCase().split(/\W+/).filter(w => w.length > 2);
  const extractedWords = new Set(extractedName.toUpperCase().split(/\W+/).filter(w => w.length > 2));
  return entityWords.some(w => extractedWords.has(w));
}

export function invoiceRefMatches(invoiceNumber: string, refs: string[]): boolean {
  if (!invoiceNumber || refs.length === 0) return false;
  const invDigits = invoiceNumber.replace(/\D/g, '');
  return refs.some(ref => invDigits === ref || invDigits.endsWith(ref));
}

// ── Multi-invoice combo detection ─────────────────────────────────────────────

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  entityName: string;
  balance: number;
  date: string;
  type: 'supplier_invoice' | 'customer_invoice';
}

/**
 * Find combinations of 2-3 invoices whose balances sum to the target amount.
 * Tolerance: R0.01.
 */
export function findInvoiceCombos(invoices: InvoiceRow[], targetAmount: number): InvoiceRow[][] {
  const combos: InvoiceRow[][] = [];
  const tolerance = 0.01;

  for (let i = 0; i < invoices.length && combos.length < 3; i++) {
    for (let j = i + 1; j < invoices.length && combos.length < 3; j++) {
      if (Math.abs(invoices[i]!.balance + invoices[j]!.balance - targetAmount) <= tolerance) {
        combos.push([invoices[i]!, invoices[j]!]);
      }
    }
  }

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

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function getMatchCandidates(
  bankTransactionId: string,
  companyId: string,
): Promise<{ candidates: MatchCandidate[] }> {
  const tx = await fetchBankTransaction(bankTransactionId, companyId);
  if (!tx) return { candidates: [] };

  const { amount: txAmount, transactionDate: txDate, description: txDesc, reference: txRef } = tx;
  const absAmount = Math.abs(txAmount);
  const isReceipt = txAmount > 0;

  const extractedEntity = extractEntityName(txDesc);
  const invoiceRefs = extractInvoiceRefs(`${txDesc} ${txRef}`);

  const args = [companyId, absAmount, txAmount, txDate, txDesc, extractedEntity, invoiceRefs] as const;

  // For receipts we prefer receiptMatchService's scored shortlist (PRD-06 Phase 4):
  // exact-reference > partial-reference + portal-view > amount + date, with
  // trigram-indexed invoice_number lookups. Falls back to the legacy
  // fetchCustomerInvoiceCandidates only if the receipt-match service returns
  // nothing (e.g., every candidate failed similarity thresholds and had no
  // amount/date signal).
  let arCandidates: MatchCandidate[] = [];
  if (isReceipt) {
    const arResult = await getReceiptMatchCandidates(bankTransactionId, companyId);
    arCandidates = arResult.candidates;
    if (arCandidates.length === 0) {
      arCandidates = await fetchCustomerInvoiceCandidates(...args);
    }
  }

  const candidateSets = await Promise.all([
    isReceipt ? [] : fetchSupplierInvoiceCandidates(...args),
    isReceipt ? [] : fetchPurchaseOrderCandidates(...args),
    fetchJournalLineCandidates(companyId, txAmount, txDate, txDesc),
  ]);

  const candidates = [...arCandidates, ...candidateSets.flat()].sort((a, b) => b.score - a.score);

  log.info('Fetched bank match candidates', {
    bankTransactionId,
    extractedEntity: extractedEntity || '(none)',
    invoiceRefs: invoiceRefs.length > 0 ? invoiceRefs.join(',') : '(none)',
    count: candidates.length,
  }, 'accounting-api');

  return { candidates };
}
