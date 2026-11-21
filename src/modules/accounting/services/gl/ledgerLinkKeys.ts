/**
 * Migration 1018's per-journal link key (`ledger_link_key`), taken by a reversal link (in sorted uuid order, for the
 * contra, the journal reversed and the chain root), by a document linking or releasing its journal, and by the deferred
 * line check (gl_jl_linked_account_check) for each changed line's journal at COMMIT, one line at a time in line order.
 */
import { sql } from '@/lib/neon';

const RETRYABLE = new Set(['55P03', '40P01']);

/** A wait for a journal's key or row that ran out (55P03) or lost a deadlock (40P01), as the caller's typed error. */
async function busyAs<T>(typed: () => Error, take: () => PromiseLike<T>): Promise<T> {
  try {
    return await take();
  } catch (err) {
    if (RETRYABLE.has(String((err as { code?: unknown } | null)?.code ?? ''))) throw typed();
    throw err;
  }
}

/**
 * Round 13 L1: the journals on an account were being reversed or linked by another request for longer than 1018's
 * 5 s bound. Nothing was changed; a retry passes. A `_LOCK_TIMEOUT` code: the API answers it 503 (lib/lockTimeout).
 */
export class JournalLinkKeysBusyError extends Error {
  readonly code = 'JOURNAL_LINK_KEYS_LOCK_TIMEOUT';
  constructor() {
    super('Journals on this account are being reversed or linked by another request. Nothing was changed; retry in a moment.');
    this.name = 'JournalLinkKeysBusyError';
  }
}

/**
 * Round 13 L1: the rows and link keys of `entryIds` and of their chain roots, in sorted order (ledger_lock_chains), so
 * a reversal holds no chain key while it waits for a lower one. A held one past the 5 s bound is `busy()`.
 */
export async function lockJournalChains(entryIds: readonly string[], busy: () => Error): Promise<void> {
  await busyAs(busy, () => sql`SELECT public.ledger_lock_chains(${[...entryIds]}::uuid[])`);
}

/**
 * Round 12 L3: before a bulk line move (the account merge), take the link keys of every journal with a line on the
 * account, in sorted uuid order: the order a reversal link takes them. The deferred check later asks for keys already
 * held, so a merge and a link wait for one another instead of deadlocking (40P01).
 */
export async function lockLinkKeysOfAccountJournals(companyId: string, accountId: string): Promise<void> {
  await busyAs(() => new JournalLinkKeysBusyError(), () => sql`
    SELECT public.ledger_lock_key(j.id) -- bounded to 5 s (1018 round 12), the order a link takes them
      FROM (SELECT DISTINCT journal_entry_id AS id FROM gl_journal_lines
             WHERE company_id = ${companyId}::UUID AND gl_account_id = ${accountId}::UUID
             ORDER BY 1 OFFSET 0) j
  `);
}
