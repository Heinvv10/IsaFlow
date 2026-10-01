// src/lib/rollbackFailed.ts
import { log } from '@/lib/logger';

/**
 * Rolls a transaction back and reports whether that FAILED (R-176).
 *
 * A connection whose ROLLBACK did not complete may still be inside its transaction. Returned to
 * the pool, it hands that open (or aborted) transaction to the next caller, whose COMMIT then
 * lands the failed work. So every transaction owner passes this result to `client.release(...)`:
 * pg-pool destroys a client released with a truthy argument. A ROLLBACK that succeeds leaves a
 * reusable connection, and `false` keeps it.
 */
export async function rollbackFailed(
  client: { query(text: string): Promise<unknown> },
  source: string,
): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch (err) {
    log.error(`${source}: ROLLBACK failed, destroying the connection`, {
      message: err instanceof Error ? err.message : String(err),
    }, 'DB');
    return true;
  }
}
