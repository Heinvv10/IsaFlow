/**
 * Run `fn` for real, then undo it: a savepoint that is ALWAYS rolled back.
 *
 * A dry run that stops at a counted guard can say "deletable" for a row the
 * live DELETE then refuses on a foreign key the guard cannot see (another
 * tenant's line, a line committed after the count). Running the real write
 * inside a savepoint and rolling it back makes the dry run meet every check the
 * live call meets — and keep nothing.
 *
 * Refused outside a request transaction: there withSavepoint degrades to a
 * plain call, and the write would stand. And never a success after a failed
 * ROLLBACK TO: withSavepoint marks the transaction unusable and rethrows our
 * sentinel, so the sentinel alone cannot tell a rollback from a write that may
 * still stand — assertTxUsable can.
 */
import { withSavepoint } from '@/lib/neon';
import { assertTxUsable } from '@/lib/als';
import { requireRequestTransaction } from './requestTransaction';

class RolledBack extends Error {
  constructor() {
    super('rolled back on purpose');
    this.name = 'RolledBack';
  }
}

export async function inRolledBackSavepoint(name: string, fn: () => Promise<unknown>): Promise<void> {
  requireRequestTransaction(name);
  try {
    await withSavepoint(name, async () => {
      await fn();
      throw new RolledBack();
    });
  } catch (err) {
    if (err instanceof RolledBack) {
      assertTxUsable();
      return;
    }
    throw err;
  }
}
