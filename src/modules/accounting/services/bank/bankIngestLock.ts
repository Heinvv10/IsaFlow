/**
 * ONE lock for every writer that dedupes against a bank account's lines and then inserts into it (WP2-2).
 *
 * Each import path reads the account's existing lines (the dedup read: a content hash, or the OCR fingerprint) and then
 * INSERTs the lines it did not find. With nothing serialising two of them, two imports of one statement both read
 * before either wrote, and the statement landed twice. Taking this lock on the request transaction BEFORE the dedup
 * read makes the second wait for the first to commit; its read, a later statement under READ COMMITTED, then sees the
 * first one's lines.
 *
 * The key is the feed writer's, `hashtextextended('bank_tx_ingest:<company>:<account>', 0)` — so a statement upload,
 * the agent import, the classified import, the OCR commit and the feed all queue on the same account. The ids go
 * through ::UUID::TEXT so the key is the canonical lower-case spelling whoever passes them.
 *
 * Bounded: `take_number_lock` (migration 864) is that advisory lock with migration 858's 5 s wait, tighten-only (a
 * caller's tighter lock_timeout is kept and put back). A wait that runs out is `BankImportLockTimeoutError`, which
 * the routes answer 503 + Retry-After (`respondIfLockTimeout`); the 55P03 has aborted the transaction, so it is never
 * a 4xx. Held to COMMIT / ROLLBACK (or to ROLLBACK TO a savepoint taken before it). Outside a request transaction
 * it serialises nothing: every caller runs on one.
 *
 * Lock order: taken FIRST, before any bank line, payment, invoice, journal or journal-number lock its path takes
 * (the auto-post sweep and the rule pass run after the insert) — `bank/.claude.md`, the lock-order table.
 */
import { sql } from '@/lib/neon';
import { isLockNotAvailable } from '../core/lockContention';

/** Another import into this bank account held the ingest lock past its 5 s bound. Retryable; nothing was written. */
export class BankImportLockTimeoutError extends Error {
  readonly code = 'BANK_IMPORT_LOCK_TIMEOUT';
  constructor() {
    super('Another import into this bank account is still running — retry in a moment.');
    this.name = 'BankImportLockTimeoutError';
  }
}

export async function lockBankAccountIngest(companyId: string, bankAccountId: string): Promise<void> {
  try {
    await sql`
      SELECT public.take_number_lock(
        'bank_tx_ingest:' || ${companyId}::UUID::TEXT || ':' || ${bankAccountId}::UUID::TEXT, 0)`;
  } catch (err) {
    if (isLockNotAvailable(err)) throw new BankImportLockTimeoutError();
    throw err;
  }
}
