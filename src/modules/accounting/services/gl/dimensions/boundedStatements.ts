/**
 * A server-side bound for the statements of the bank-row sync and its reversal
 * (dimensionBankSync.ts, dimensionTagApply.ts): a bad plan or a lock wait can
 * never hang a request. Split out of dimensionBankSync.ts for the 300-line cap.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BankDimensionSyncRefusal } from './dimensionBankSyncTypes';

/** Longest the candidate read (or its lock wait) may run; the caller's own tighter statement_timeout still wins. */
export const BANK_SYNC_STATEMENT_TIMEOUT_MS = 20_000;
const QUERY_CANCELED = '57014';
const TX_ABORTED = '25P02';

/**
 * Run `fn` with statement_timeout tightened to `ms` (never loosened past the caller's own budget) and JIT off
 * (its compile time is pure overhead for these nested-loop reads), and put both back afterwards on EVERY path, a
 * thrown error included. A statement the bound cancels (57014) is a BankDimensionSyncRefusal worded with `what`
 * and `remedy`; any other error is re-thrown untouched. After a SQL error the transaction is aborted and the
 * restore itself fails (25P02): that is noted at debug (the settings are LOCAL and unwind with the
 * savepoint), any other restore failure is a warning, and neither replaces the error that caused it.
 */
export async function withBoundedStatements<T>(
  fn: () => Promise<T>, ms = BANK_SYNC_STATEMENT_TIMEOUT_MS,
  words: { what: string; remedy: string } = { what: 'bank sync read', remedy: 'narrow date_from / date_to and run it again' },
): Promise<T> {
  const [prev] = (await sql`
    SELECT (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS timeout_ms,
           (SELECT setting FROM pg_settings WHERE name = 'jit') AS jit
  `) as { timeout_ms: string; jit: string }[];
  const before = Number(prev?.timeout_ms ?? 0);
  const bound = before > 0 ? Math.min(before, ms) : ms;
  await sql`SELECT set_config('statement_timeout', ${`${bound}ms`}, true), set_config('jit', 'off', true)`;
  let failed = false;
  try {
    return await fn();
  } catch (err) {
    failed = true;
    if ((err as { code?: unknown }).code === QUERY_CANCELED) {
      throw new BankDimensionSyncRefusal(`The ${words.what} ran longer than ${bound / 1000}s and was cancelled: ${words.remedy}.`);
    }
    throw err;
  } finally {
    try {
      await sql`SELECT set_config('statement_timeout', ${`${before}ms`}, true), set_config('jit', ${prev?.jit ?? 'on'}, true)`;
    } catch (restoreErr) {
      if (!failed) throw restoreErr;
      // The error that got us here aborted the transaction (25P02 on every later statement). Both settings are
      // LOCAL: they unwind with the savepoint or transaction, so there is nothing to act on. Any other failure to
      // restore is unexpected and stays a warning.
      const detail = { err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) };
      if ((restoreErr as { code?: unknown }).code === TX_ABORTED) log.debug('Statement bound not restored: transaction already aborted', detail, 'accounting');
      else log.warn('Bank sync could not restore statement_timeout after an error', detail, 'accounting');
    }
  }
}
