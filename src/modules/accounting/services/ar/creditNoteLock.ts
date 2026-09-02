/**
 * Row-lock helper for the credit-note WRITE paths.
 *
 * approveCreditNote and cancelCreditNote both read `credit_notes.status`,
 * refuse on the wrong status, and then post to the ledger and rewrite the row.
 * That is a check-then-act window, and it is not theoretical here: two
 * concurrent `approve_credit_note` calls on the same draft both read 'draft',
 * both build a journal, and both post one — proven against a real database,
 * where six paired attempts produced two posted entries for the same note. A
 * linked note also adds its total to the invoice's `amount_paid` on each pass,
 * so the same race double-credits the receivable.
 *
 * A fresh idempotency key defeats the registry's replay guard, so an agent
 * retrying an apparently-hung call is exactly the caller that triggers this.
 * The UI double-click is the same shape.
 *
 * This mirrors bankTxLock.ts deliberately — same defect class, same remedy.
 * Since PR #264 every request runs inside a single transaction on the
 * AsyncLocalStorage-bound client, so `FOR UPDATE` taken here is held for the
 * rest of the request: the second request blocks on the row until the first
 * commits, then re-reads the settled status and refuses.
 *
 * Write paths ONLY — never call this from a list/query service.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the row longer than the 5s `lock_timeout`.
 * Credit-note routes surface a caught service error's message to the caller, so
 * this wording has to say "retry".
 */
export class CreditNoteLockTimeoutError extends Error {
  readonly code = 'CREDIT_NOTE_LOCK_TIMEOUT';
  constructor(creditNoteId: string) {
    super(`Credit note ${creditNoteId} is being processed by another request — retry in a moment.`);
    this.name = 'CreditNoteLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Read one credit note for a company and hold a row lock on it until the end of
 * the surrounding transaction. Returns `null` when the row does not exist or
 * belongs to another tenant — callers keep their own not-found wording.
 *
 * Throws if no request transaction is in flight: outside one, every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not. A loud
 * failure beats a lock that silently does nothing.
 *
 * The 5s `lock_timeout` is re-issued on EVERY call rather than memoised — see
 * bankTxLock.ts for why (`SET LOCAL` is subtransaction-aware, and a savepoint
 * rollback restores it to `0`, meaning no timeout at all).
 */
export async function lockCreditNoteForUpdate(
  companyId: string,
  creditNoteId: string,
): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockCreditNoteForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT * FROM credit_notes
      WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
      FOR UPDATE`) as DbRow[];
    // Restore the default ON THE SUCCESS PATH ONLY. `SET LOCAL` lasts to the end
    // of the TRANSACTION, not the statement, so without this the 5s budget
    // silently governs every lock taken afterwards in the same request —
    // including the journal posting and the reversal this function is usually
    // called before. Those would then fail with a bare 55P03 that nothing maps
    // to CreditNoteLockTimeoutError, reaching the agent as GENERIC_FAILURE.
    //
    // Deliberately NOT in a `finally`: after a lock timeout the transaction is
    // aborted, so this statement would itself throw 25P02 and REPLACE the typed
    // error with an opaque one — which is exactly what happened when it was
    // written that way (creditNoteLock.test.ts caught it). On the failure path
    // the setting is irrelevant, because the transaction is being rolled back.
    //
    // The row lock is unaffected either way: it is already held, and locks are
    // released by COMMIT, not by this setting. (bankTxLock.ts carries the same
    // latent leak; deliberately not changed from here.)
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new CreditNoteLockTimeoutError(creditNoteId);
    throw err;
  }
}
