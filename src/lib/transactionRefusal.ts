/**
 * An expected refusal thrown inside `withTransaction` only to roll it back —
 * the caller answers it as a 4xx. It is not a failure, so the rollback is
 * logged at info; every other error still logs at error, exactly as before.
 */
import { log } from '@/lib/logger';

export class TransactionRefusal extends Error {}

/** The one rollback log line `withTransaction` writes, at the level `err` deserves. */
export function logTransactionRollback(message: string, err: unknown): void {
  if (err instanceof TransactionRefusal) {
    log.info(message, { refusal: err.message }, 'DB');
    return;
  }
  log.error(message, err instanceof Error ? { message: err.message } : { error: err }, 'DB');
}
