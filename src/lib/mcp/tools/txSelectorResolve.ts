/**
 * Turning a caller's transaction selector into a transaction id.
 *
 * Split out of allocationLine.ts when the resolution became BATCHED: the bulk
 * tool resolves up to 500 selectors inside one request that already holds row
 * locks, so a per-line query was 500 round trips of lock hold time (~3 ms each
 * on a full-company scan before migration 519's indexes — ~1.5 s of pure
 * scanning). `resolveTxSelectors` asks the database once per distinct
 * bank-account scope, and every caller — single tool included — goes through it.
 */
import {
  findBankTransactionsByReferences,
  type BankTransactionRefMatch,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { NOT_FOUND } from './toolHelpers';

// ── Transaction selector (PRD-11 §5) ────────────────────────────────────────
//
// The agent reads a bank statement, not the database, so it holds the printed
// reference rather than a UUID. Exactly one of the two: given both, they
// can name different rows and there is no safe precedence — a tie-break here
// would post against whichever the tool happened to prefer.
export type TxSelector = { txId: string } | { ref: string; bankAccountId?: string };

export type ResolvedSelector = { id: string } | { error: string };

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Returns the selector, or the error text to refuse with. */
export function pickTxSelector(args: Record<string, unknown>): TxSelector | string {
  const txId = str(args, 'transaction_id');
  const ref = str(args, 'bank_reference');
  if (txId && ref) {
    return 'Provide either transaction_id or bank_reference, not both — they may name different transactions.';
  }
  if (!txId && !ref) return 'transaction_id or bank_reference is required';
  if (txId) return { txId };
  // bank_account_id only NARROWS a query already fenced to ctx.companyId, so
  // it never becomes a foreign key and needs no ownership check of its own:
  // a foreign id simply matches nothing.
  const bankAccountId = str(args, 'bank_account_id');
  return bankAccountId ? { ref, bankAccountId } : { ref };
}

/** One reference's candidates → an id, or the refusal text. */
function decide(matches: BankTransactionRefMatch[] | undefined): ResolvedSelector {
  // Same text as a genuine miss: a reference that resolves in another tenant
  // must read identically to one that exists nowhere (no existence oracle).
  if (!matches || matches.length === 0) return { error: NOT_FOUND };
  if (matches.length > 1) {
    // Never take the first: same-reference rows differ by date and amount, and
    // guessing posts this month's journal against last month's transaction.
    // The COLUMN is listed beside the value: candidates resolved out of
    // `bank_reference` came from a bank feed's external id rather than anything
    // printed on a statement, and a human deciding between them needs to know
    // that. (Preference order means one set or the other, never a mix.)
    const listed = matches
      .map((m) => `${m.id} (${m.transactionDate}, ${m.amount.toFixed(2)}, `
        + `${m.matchedColumn} "${m.matchedReference}")`)
      .join('; ');
    return {
      error: `bank_reference is ambiguous — ${matches.length} transactions carry it: ${listed}. `
        + 'Re-issue with transaction_id, or narrow with bank_account_id.',
    };
  }
  return { id: matches[0]!.id };
}

/**
 * Resolves EVERY selector, in one lookup query per distinct bank-account scope
 * (one query outright for the usual batch, where every line either names the
 * same account or names none). Order of the results matches the input.
 */
export async function resolveTxSelectors(
  selectors: readonly TxSelector[],
  companyId: string,
): Promise<ResolvedSelector[]> {
  // Group by the narrowing account: two lines scoped to different accounts
  // cannot share a query without one of them silently widening.
  const groups = new Map<string, string[]>();
  for (const sel of selectors) {
    if ('txId' in sel) continue;
    const key = sel.bankAccountId ?? '';
    const refs = groups.get(key);
    if (refs) refs.push(sel.ref);
    else groups.set(key, [sel.ref]);
  }

  const lookups = new Map<string, Map<string, BankTransactionRefMatch[]>>();
  for (const [key, refs] of groups) {
    lookups.set(
      key,
      await findBankTransactionsByReferences(companyId, refs, key === '' ? undefined : key),
    );
  }

  return selectors.map((sel) => {
    if ('txId' in sel) return { id: sel.txId };
    const found = lookups.get(sel.bankAccountId ?? '')?.get(sel.ref.trim());
    return decide(found);
  });
}

/** Resolves a selector to one transaction id, or the error text to refuse with. */
export async function resolveTxId(
  sel: TxSelector,
  companyId: string,
): Promise<ResolvedSelector> {
  const [resolved] = await resolveTxSelectors([sel], companyId);
  return resolved!;
}
