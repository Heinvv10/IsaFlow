import type { PoolClient } from 'pg';
import { settleControlTransaction } from '@/modules/accounting/services/controls/transactionObservers';

/** PostgreSQL can answer COMMIT with ROLLBACK after a caught statement error. */
export async function finalizeRequestTransaction(client: PoolClient, rollback: boolean): Promise<void> {
  const expected = rollback ? 'ROLLBACK' : 'COMMIT';
  const result = await client.query(expected);
  if (result.command !== expected) {
    await settleControlTransaction(client, result.command === 'ROLLBACK' ? 'rolled_back' : 'unknown');
    throw new Error('Database transaction did not finish with the expected outcome');
  }
  await settleControlTransaction(client, rollback ? 'rolled_back' : 'committed');
}
