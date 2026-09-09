import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { requireControlTx } from './context';
export type TransactionOutcome = 'committed' | 'rolled_back' | 'unknown';
type Observer = (outcome: TransactionOutcome) => void | Promise<void>;
const observers = new WeakMap<PoolClient, Observer[]>();

/** Registration requires an active authenticated transaction; only middleware settles it. */
export function observeControlTransaction(observer: Observer): void {
  requireControlTx();
  const client = als.getStore()!.client;
  const pending = observers.get(client) ?? [];
  if (pending.length >= 64) throw new Error('Control transaction observer limit exceeded');
  pending.push(observer); observers.set(client, pending);
}

/** A failed notification cannot undo a durable commit; retained admission remains recoverable. */
export async function settleControlTransaction(client: PoolClient, outcome: TransactionOutcome): Promise<void> {
  const pending = observers.get(client) ?? [];
  observers.delete(client);
  for (const observer of pending) {
    try { await observer(outcome); }
    catch { log.error('Control transaction observer failed; durable attempt requires reconciliation', { outcome }, 'controls'); }
  }
}
