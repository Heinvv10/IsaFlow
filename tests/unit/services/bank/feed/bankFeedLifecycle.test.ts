// tests/unit/services/bank/feed/bankFeedLifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { decideFeedTransition, type ExistingFeedRow } from '@/modules/accounting/services/bank/feed/bankFeedLifecycle';
import type { NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

const base: NormalizedBankTransaction = {
  identity: { kind: 'provider', providerTransactionId: 'p1' }, state: 'posted',
  transactionDate: '2026-09-01', amount: -100, currency: 'ZAR', description: 'SHOP',
  providerUpdatedAt: '2026-09-01T10:00:00Z',
};
const existing = (o: Partial<ExistingFeedRow> = {}): ExistingFeedRow => ({
  id: 'bt1', feedState: 'posted', processed: false, transactionDate: '2026-09-01', valueDate: null,
  amount: -100, description: 'SHOP', reference: null, providerUpdatedAt: '2026-09-01T10:00:00Z', ...o,
});
const inc = (o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({ ...base, ...o });

describe('decideFeedTransition', () => {
  it.each<[string, ExistingFeedRow | null, NormalizedBankTransaction, string]>([
    ['new posted', null, inc(), 'insert'],
    ['new pending', null, inc({ state: 'pending' }), 'insert'],
    ['unknown removed', null, inc({ state: 'removed' }), 'ignore_removed_unknown'],
    ['removed again', existing({ feedState: 'removed' }), inc({ state: 'removed', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
    ['removed reappears', existing({ feedState: 'removed' }), inc({ providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:removed_row_reappeared'],
    ['pending posts', existing({ feedState: 'pending' }), inc({ amount: -101 }), 'post_pending'],
    ['pending removed', existing({ feedState: 'pending' }), inc({ state: 'removed' }), 'remove_pending'],
    ['pending same', existing({ feedState: 'pending' }), inc({ state: 'pending' }), 'duplicate'],
    ['pending changed newer', existing({ feedState: 'pending' }), inc({ state: 'pending', amount: -99, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'refresh'],
    ['posted stale replay', existing(), inc({ amount: -1, providerUpdatedAt: '2026-08-01T00:00:00Z' }), 'duplicate'],
    ['posted removed', existing(), inc({ state: 'removed', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:posted_row_removed'],
    ['posted to pending', existing(), inc({ state: 'pending', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:posted_row_reverted_to_pending'],
    ['posted same', existing(), inc({ providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
    ['processed changed', existing({ processed: true }), inc({ amount: -5, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'conflict:processed_row_changed'],
    ['unprocessed changed newer', existing(), inc({ description: 'SHOP 2', providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'refresh'],
    ['unprocessed changed unordered', existing({ providerUpdatedAt: null }), inc({ description: 'SHOP 2', providerUpdatedAt: undefined }), 'conflict:unordered_change'],
    ['amount equal to the cent', existing(), inc({ amount: -100.001, providerUpdatedAt: '2026-09-02T00:00:00Z' }), 'duplicate'],
  ])('%s', (_name, ex, incoming, expected) => {
    const d = decideFeedTransition(ex, incoming);
    expect(d.kind === 'conflict' ? `conflict:${d.reason}` : d.kind).toBe(expected);
  });
});
