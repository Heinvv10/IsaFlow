/**
 * PRD-060: FibreFlow Accounting Module
 * Bank Transaction Auto-Match Algorithm
 *
 * Four-tier matching strategy:
 *   Tier 0: Rule-based match via bank_categorisation_rules (confidence 1.0)
 *   Tier 1: Exact reference match (confidence 1.0)
 *   Tier 2: Amount + date within 3 days (confidence 0.9)
 *   Tier 3: Amount only match (confidence 0.7)
 */

import type { AutoMatchCandidate } from '../types/bank.types';

interface BankTxForMatch {
  id: string;
  amount: number;
  transactionDate: string;
  reference?: string;
  description?: string;
}

interface JournalLineForMatch {
  id: string;
  debit: number;
  credit: number;
  description?: string;
  entryDate: string;
  entryNumber?: string;
  sourceDocumentId?: string;
}

/**
 * Find match candidates for a single bank transaction against unmatched GL journal lines.
 * Returns candidates sorted by confidence DESC.
 */
export function findMatchCandidates(
  bankTx: BankTxForMatch,
  glLines: JournalLineForMatch[],
  threshold: number = 0.7
): AutoMatchCandidate[] {
  const candidates: AutoMatchCandidate[] = [];
  const txAmount = Math.abs(bankTx.amount);
  const isDeposit = bankTx.amount > 0;

  for (const line of glLines) {
    // For deposits, match against credit lines; for withdrawals, match against debit lines
    const lineAmount = isDeposit ? line.credit : line.debit;
    if (lineAmount <= 0) continue;

    const amountMatch = Math.abs(txAmount - lineAmount) < 0.02;
    if (!amountMatch) continue;

    // Tier 1: Exact reference match
    if (bankTx.reference && bankTx.reference.trim().length > 2) {
      const ref = bankTx.reference.toLowerCase().trim();
      const lineDesc = (line.description || '').toLowerCase();
      const entryNum = (line.entryNumber || '').toLowerCase();
      const sourceDoc = (line.sourceDocumentId || '').toLowerCase();

      if (lineDesc.includes(ref) || entryNum.includes(ref) || ref.includes(entryNum) || sourceDoc.includes(ref)) {
        candidates.push({
          bankTransactionId: bankTx.id,
          journalLineId: line.id,
          confidence: 1.0,
          matchReason: 'exact_reference',
        });
        continue;
      }
    }

    // Check description-based reference match
    if (bankTx.description && bankTx.description.trim().length > 3) {
      const desc = bankTx.description.toLowerCase().trim();
      const lineDesc = (line.description || '').toLowerCase();
      if (lineDesc.length > 3 && (desc.includes(lineDesc) || lineDesc.includes(desc))) {
        candidates.push({
          bankTransactionId: bankTx.id,
          journalLineId: line.id,
          confidence: 0.95,
          matchReason: 'exact_reference',
        });
        continue;
      }
    }

    // Tier 2: Amount + date within 3 days
    const daysDiff = Math.abs(dateDiffDays(bankTx.transactionDate, line.entryDate));
    if (daysDiff <= 3) {
      candidates.push({
        bankTransactionId: bankTx.id,
        journalLineId: line.id,
        confidence: 0.9,
        matchReason: 'amount_date',
      });
      continue;
    }

    // Tier 3: Amount only
    candidates.push({
      bankTransactionId: bankTx.id,
      journalLineId: line.id,
      confidence: 0.7,
      matchReason: 'amount_only',
    });
  }

  return candidates
    .filter(c => c.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Run auto-match across multiple bank transactions.
 * Returns best single match per bank transaction (highest confidence).
 * Prevents duplicate GL line matches.
 */
export function runAutoMatch(
  bankTxs: BankTxForMatch[],
  glLines: JournalLineForMatch[],
  threshold: number = 0.7
): { matches: AutoMatchCandidate[]; unmatched: string[] } {
  const matches: AutoMatchCandidate[] = [];
  const usedGlLines = new Set<string>();
  const unmatched: string[] = [];

  // Sort bank transactions by amount DESC for better matching priority
  const sorted = [...bankTxs].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  for (const tx of sorted) {
    const availableLines = glLines.filter(l => !usedGlLines.has(l.id));
    const candidates = findMatchCandidates(tx, availableLines, threshold);

    if (candidates.length > 0) {
      const best = candidates[0]!;
      matches.push(best);
      usedGlLines.add(best.journalLineId);
    } else {
      unmatched.push(tx.id);
    }
  }

  return { matches, unmatched };
}

function dateDiffDays(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}
