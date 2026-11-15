/**
 * Deterministic content hash for a parsed bank transaction.
 *
 * Used as a duplicate-detection fingerprint when importing statements so
 * the user doesn't accidentally double-import the same rows. The hash
 * covers fields that SHOULD be unique per real-world transaction:
 *
 *   date  + amount + description + balance
 *
 * Including `balance` (running balance after the transaction) is what
 * lets two legitimate coffee purchases for the same amount on the same
 * day to the same merchant be treated as distinct — they will have
 * different running balances because they happened at different times
 * in the day.
 *
 * Values are normalised before hashing:
 *   - date     → YYYY-MM-DD (no time component)
 *   - amount   → number → fixed 2dp string ("1234.56", "-1234.56")
 *   - desc     → trim + collapse whitespace + lowercase
 *   - balance  → "" if undefined, else fixed 2dp string
 *
 * The hash is stable across imports: same input always produces the
 * same 64-character hex string. Collisions are astronomically unlikely
 * for real banking data (SHA-256, full content).
 */

import { createHash } from 'node:crypto';

export interface HashableTransaction {
  transactionDate: string;
  amount: number;
  description: string;
  balance?: number | undefined;
}

/** Normalise a description: collapse whitespace, lowercase, trim. */
function normaliseDesc(desc: string): string {
  return desc.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Round to 2dp the way Postgres does, not the way JS does.
 *
 * `bank_transactions.amount` is NUMERIC(15,2): the driver sends the number as
 * its decimal string and Postgres rounds THAT, halves AWAY FROM ZERO.
 * `Math.round(n * 100)` differs twice: it rounds halves toward +Infinity
 * (-25.005 stores as -25.01, Math.round gives -25.00), and `n * 100` is binary
 * (1.005 * 100 is 100.49999999999999, so 1.005 stores as 1.01 but rounds to
 * 1.00). Either way the stored row and the statement line it came from hash
 * differently forever, and the line is re-imported on every retry. So the
 * decimal point is moved in the decimal string, and the magnitude is rounded.
 * Every import path hashes through here (WP2-2), so they all round alike.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  const [mantissa, exponent = '0'] = String(Math.abs(n)).split('e');
  const cents = Math.round(Number(`${mantissa}e${Number(exponent) + 2}`));
  return (n < 0 ? -cents : cents) / 100;
}

/** Format a number to fixed 2dp string (same output for 100 and 100.00). */
function toFixedStr(n: number): string {
  if (!Number.isFinite(n)) return '';
  // Round to avoid floating-point artefacts (e.g. 0.1 + 0.2).
  return round2(n).toFixed(2);
}

/** Normalise a date to YYYY-MM-DD (strips any time part). */
function normaliseDate(date: string): string {
  // Already YYYY-MM-DD → return as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  // YYYY-MM-DDTHH:MM:SS... → take first 10 chars.
  if (/^\d{4}-\d{2}-\d{2}T/.test(date)) return date.slice(0, 10);
  // Everything else → attempt Date parse.
  const d = new Date(date);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  // Unparseable → fall back to the raw value so the hash still distinguishes
  // different bad inputs rather than collapsing them all to the same bucket.
  return date;
}

/**
 * Compute the SHA-256 content hash for a parsed transaction.
 * Returns a 64-character hex string.
 */
export function bankTransactionHash(tx: HashableTransaction): string {
  const parts = [
    normaliseDate(tx.transactionDate),
    toFixedStr(tx.amount),
    normaliseDesc(tx.description ?? ''),
    tx.balance === undefined ? '' : toFixedStr(tx.balance),
  ];
  const joined = parts.join('|');
  return createHash('sha256').update(joined).digest('hex');
}

/**
 * Build a Set of hashes from an array of transactions — convenient for
 * the preview/duplicate-detection step where we want O(1) lookups.
 */
export function bankTransactionHashSet(txs: HashableTransaction[]): Set<string> {
  const out = new Set<string>();
  for (const tx of txs) out.add(bankTransactionHash(tx));
  return out;
}
