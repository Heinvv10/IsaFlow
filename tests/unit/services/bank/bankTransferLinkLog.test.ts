/** listTransferLinks / groupTransferLinks (migration 978): the reader behind the Bank Transactions notice and log. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, values: [] as unknown[], text: '' }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    h.text = strings.join('?');
    h.values = values;
    return Promise.resolve(h.rows);
  }), { unsafe: vi.fn((text: string, values: unknown[]) => ({ text, values })) }),
}));

import { listTransferLinks, pairNotUndoneFragment } from '@/modules/accounting/services/bank/bankTransferLinkLog';

const CO = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';

beforeEach(() => { h.rows = []; h.values = []; h.text = ''; });

describe('listTransferLinks', () => {
  it('scopes every table it reads to the company and the bank account', async () => {
    await listTransferLinks(CO, BANK);
    expect(h.values.filter((v) => v === CO)).toHaveLength(4);
    expect(h.values).toContain(BANK);
    expect(h.text).toMatch(/l\.company_id = \?::UUID/);
    expect(h.text).toMatch(/bt\.company_id = \?::UUID/);
    expect(h.text).toMatch(/ga\.company_id = \?::UUID/);
  });

  it('limits whole batches, not rows, and judges liveness from the line as the undo does', async () => {
    await listTransferLinks(CO, BANK);
    expect(h.text).toMatch(/GROUP BY link_batch_id[\s\S]*LIMIT \?/);
    expect(h.values).toContain(50);
    expect(h.text).not.toMatch(/LIMIT 300/);
    expect(h.text).toMatch(/bt\.updated_at = l\.linked_row_updated_at/);
    expect(h.text).toMatch(/bt\.matched_journal_line_id = l\.journal_line_id/);
  });

  it('groups rows by batch in order, counts the live links and normalises Date and string stamps', async () => {
    h.rows = [
      { id: 'l1', link_batch_id: 'b1', trigger_source: 'page_load', linked_at: new Date('2026-11-12T08:00:00.123Z'),
        undone_at: null, bank_transaction_id: 't1', transaction_date: '2026-11-10', description: 'Transfer to savings',
        amount: '1500.50', account_name: 'Savings', still_linked: true },
      { id: 'l2', link_batch_id: 'b1', trigger_source: 'page_load', linked_at: new Date('2026-11-12T08:00:00.123Z'),
        undone_at: '2026-11-12T09:00:00.000Z', bank_transaction_id: 't2', transaction_date: '2026-11-11',
        description: null, amount: -20, account_name: null, still_linked: false },
      { id: 'l4', link_batch_id: 'b1', trigger_source: 'page_load', linked_at: new Date('2026-11-12T08:00:00.123Z'),
        undone_at: null, bank_transaction_id: 't4', transaction_date: '2026-11-11', description: 'Reversed later',
        amount: 5, account_name: null, still_linked: false },
      { id: 'l3', link_batch_id: 'b2', trigger_source: 'import', linked_at: '2026-11-01T10:00:00.000Z',
        undone_at: new Date('2026-11-02T10:00:00.000Z'), bank_transaction_id: 't3',
        transaction_date: new Date(2026, 9, 31), description: 'Inter-account transfer', amount: 10, account_name: 'Call' },
    ];
    const batches = await listTransferLinks(CO, BANK);
    expect(batches.map((b) => [b.batchId, b.source, b.activeCount, b.links.length])).toEqual([
      ['b1', 'page_load', 1, 3], ['b2', 'import', 0, 1],
    ]);
    expect(batches[0].linkedAt).toBe('2026-11-12T08:00:00.123Z');
    expect(batches[0].links[0]).toEqual({
      id: 'l1', bankTransactionId: 't1', transactionDate: '2026-11-10', description: 'Transfer to savings',
      amount: 1500.5, counterpartyAccountName: 'Savings', state: 'linked', undoneAt: null,
    });
    expect(batches[0].links[1]).toMatchObject({ description: null, counterpartyAccountName: null, state: 'undone', undoneAt: '2026-11-12T09:00:00.000Z' });
    // A row with no undo stamp whose line moved on (a Reverse, a reconcile) is changed, not live.
    expect(batches[0].links[2]).toMatchObject({ state: 'changed', undoneAt: null });
    expect(batches[1].links[0]).toMatchObject({ transactionDate: '2026-10-31', undoneAt: '2026-11-02T10:00:00.000Z' });
  });
});

describe('pairNotUndoneFragment', () => {
  it('binds the company and correlates on the given columns, undone rows only', () => {
    const f = pairNotUndoneFragment('bt_new.id', 'sa.target_je_line_id', CO) as unknown as { text: string; values: unknown[] };
    expect(f.values).toEqual([CO]);
    expect(f.text).toMatch(/u\.company_id = \$1::UUID/);
    expect(f.text).toMatch(/u\.bank_transaction_id = bt_new\.id/);
    expect(f.text).toMatch(/u\.journal_line_id = sa\.target_je_line_id/);
    expect(f.text).toMatch(/u\.undone_at IS NOT NULL/);
  });
});
