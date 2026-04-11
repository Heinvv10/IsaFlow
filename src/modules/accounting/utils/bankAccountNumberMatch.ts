/**
 * Bank account number matching for the statement-import security gate.
 *
 * When a user uploads a bank statement into a selected bank account, we
 * want to refuse the import if the statement clearly belongs to a
 * DIFFERENT account than the one the user picked. That prevents both
 * accidental mis-imports and a deliberate attacker who has access to one
 * account but tries to funnel statements from another account into it.
 *
 * Account numbers in South African banks come with a lot of noise:
 *   - Header prints: "Account Number: 1234 5678" or "Acc No: 12345678"
 *   - Internal storage: "12345678" or "1234-5678" or "1234 5678"
 *   - Sometimes with a country / bank prefix: "ZA12345678"
 *   - Sometimes masked in UI: "•••• 5678"
 *
 * Comparison rules:
 *   - Strip all non-digit characters from both sides.
 *   - If either is empty after stripping → "indeterminate" (let caller decide).
 *   - Exact match → "match".
 *   - One side ends-with the other (to handle prefixes / masking) → "match".
 *   - Otherwise → "mismatch".
 */

export type BankAccountMatchResult = 'match' | 'mismatch' | 'indeterminate';

/** Strip everything except digits. */
function normalise(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\D/g, '');
}

/**
 * Compare an account number extracted from an uploaded statement to the
 * account number stored on the bank account the user selected for import.
 *
 * The comparison is deliberately lenient on formatting (spaces, dashes,
 * country prefixes) and strict on digits.
 */
export function compareBankAccountNumbers(
  statementAccountNumber: string | null | undefined,
  storedAccountNumber: string | null | undefined,
): BankAccountMatchResult {
  const a = normalise(statementAccountNumber);
  const b = normalise(storedAccountNumber);

  // Can't verify: one or both are missing / empty after normalisation.
  if (!a || !b) return 'indeterminate';

  // Exact match.
  if (a === b) return 'match';

  // Prefix/mask tolerance — the longer number must end with the shorter.
  // Only allowed when the shorter side is at least 4 digits (otherwise
  // we'd accept almost anything).
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && longer.endsWith(shorter)) return 'match';

  return 'mismatch';
}
