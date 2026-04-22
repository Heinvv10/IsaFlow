/**
 * Bank Statement Dedup Helpers — PRD-05 Phase 7
 *
 * Fingerprint + fuzzy matching logic isolated for testability and line-count compliance.
 */

import { sql } from '@/lib/neon';
import type { ExtractedBankTransaction } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DedupResult {
  isDuplicate: boolean;
  duplicateOfBankTxId: string | null;
  duplicateMatchConfidence: number;
}

interface ExistingTx {
  id: string;
  transaction_date: string;
  amount: number;
  description: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dice-coefficient on bigrams for fuzzy description matching. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    intersection += Math.min(count, bMap.get(bg) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

/** Fingerprint: date|amount|first-30-chars-of-description (lower-cased, normalised). */
export function fingerprint(date: string, amount: number, description: string): string {
  const desc30 = description.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
  return `${date}|${amount}|${desc30}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Dedup pass
// ---------------------------------------------------------------------------

export async function runDedupPass(
  companyId: string,
  bankAccountId: string,
  rows: ExtractedBankTransaction[],
): Promise<DedupResult[]> {
  if (rows.length === 0) return [];

  const validDates = rows.map((r) => r.date).filter(Boolean) as string[];
  if (validDates.length === 0) {
    return rows.map(() => ({ isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }));
  }

  const minDate = validDates.reduce((a, b) => (a < b ? a : b));
  const maxDate = validDates.reduce((a, b) => (a > b ? a : b));
  const windowStart = addDays(minDate, -1);
  const windowEnd = addDays(maxDate, 1);

  const existing = (await sql`
    SELECT id, transaction_date::text AS transaction_date, amount::float AS amount, description
    FROM bank_transactions
    WHERE company_id = ${companyId}
      AND bank_account_id = ${bankAccountId}::uuid
      AND transaction_date BETWEEN ${windowStart}::date AND ${windowEnd}::date
  `) as ExistingTx[];

  const fpIndex = new Map<string, ExistingTx>();
  for (const tx of existing) {
    const fp = fingerprint(tx.transaction_date, tx.amount, tx.description);
    fpIndex.set(fp, tx);
  }

  return rows.map((row): DedupResult => {
    const date = row.date ?? '';
    if (!date) return { isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 };

    // Exact fingerprint match → confidence 1.0
    const fp = fingerprint(date, row.amount, row.description);
    const exactMatch = fpIndex.get(fp);
    if (exactMatch) {
      return { isDuplicate: true, duplicateOfBankTxId: exactMatch.id, duplicateMatchConfidence: 1.0 };
    }

    // Fuzzy: same amount, date ±1d, description dice ≥ 0.7 → confidence 0.9
    const descNorm = row.description.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const tx of existing) {
      if (tx.amount !== row.amount) continue;
      const dateDiff = Math.abs(new Date(tx.transaction_date).getTime() - new Date(date).getTime());
      if (dateDiff > 86_400_000) continue;
      const existDescNorm = tx.description.toLowerCase().replace(/\s+/g, ' ').trim();
      const dice = diceCoefficient(descNorm, existDescNorm);
      if (dice >= 0.7) {
        return { isDuplicate: true, duplicateOfBankTxId: tx.id, duplicateMatchConfidence: 0.9 };
      }
    }

    return { isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 };
  });
}
