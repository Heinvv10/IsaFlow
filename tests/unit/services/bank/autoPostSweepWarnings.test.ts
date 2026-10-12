/**
 * What `sweep` reports of the cost-centre picks `postProvisional` could not
 * apply (PR #688 follow-up F3): one entry per posted bank transaction, with its
 * journal and a short label of the bank line (date and amount in the app's currency format) so a screen can
 * say WHICH line; nothing for a row whose post was rolled back. The rollback is
 * proved against a real database in
 * tests/integration/autopost-sweep-pick-warnings.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }) }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
  transaction: vi.fn(),
  withSavepoint: vi.fn(<T,>(_name: string, fn: () => Promise<T>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({ postProvisional: vi.fn() }));

import { formatCurrency } from '@/utils/formatters';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';

const W = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const txRow = (id: string, amount: number, transaction_date: unknown) => ({
  id, status: 'imported', feed_state: 'posted', amount, transaction_date,
  suggested_gl_account_id: null, suggested_confidence: null, suggested_vat_code: null, description: `EFT ${id}`,
});
const run = (rows: unknown[], tagFails: (call: number) => boolean) => {
  let tags = 0;
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/FROM bank_auto_post_settings/.test(text)) {
      return Promise.resolve([{ enabled: true, min_confidence: '0.9', amount_cap: '10000', llm_enabled: false, llm_min_confidence: '0.95', llm_amount_cap: '2000' }]);
    }
    if (/FROM bank_transactions\s+WHERE id = ANY/.test(text)) return Promise.resolve(rows);
    if (/INSERT INTO bank_auto_post_runs/.test(text)) return Promise.resolve([{ id: 'run-1' }]);
    if (/UPDATE bank_transactions SET auto_post_run_id/.test(text)) {
      tags += 1;
      return tagFails(tags) ? Promise.reject(new Error('tag failed')) : Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  return sweep('co-1', rows.map((r) => (r as { id: string }).id), 'import', 'u-1', 'importer-1');
};

describe('sweep — cost-centre picks the provisional path dropped', () => {
  beforeEach(() => { sqlMock.mockReset(); vi.mocked(postProvisional).mockReset(); });

  it('returns each under its bank transaction and journal, labelled with the line\'s date and amount', async () => {
    vi.mocked(postProvisional)
      .mockResolvedValueOnce({ journalEntryId: 'je-1', prediction: {} as never, warnings: [W] })
      .mockResolvedValueOnce({ journalEntryId: 'je-2', prediction: {} as never })
      .mockResolvedValueOnce({ journalEntryId: 'je-3', prediction: {} as never, warnings: [W, W.replace('Line 1', 'Line 2')] });

    const r = await run([txRow('t1', -230, '2026-10-02'), txRow('t2', -10, '2026-10-02'), txRow('t3', -1150.5, new Date(2026, 9, 3))], () => false);

    expect(r.posted).toBe(3);
    expect(r.warnings).toEqual([
      { txId: 't1', journalEntryId: 'je-1', label: `2026-10-02 ${formatCurrency(230)}`, description: 'EFT t1', warnings: [W] },
      { txId: 't3', journalEntryId: 'je-3', label: `2026-10-03 ${formatCurrency(1150.5)}`, description: 'EFT t3', warnings: [W, W.replace('Line 1', 'Line 2')] },
    ]);
  });

  it('does not report a pick for a row whose post was rolled back with its savepoint', async () => {
    vi.mocked(postProvisional)
      .mockResolvedValueOnce({ journalEntryId: 'je-1', prediction: {} as never, warnings: [W] })
      .mockResolvedValueOnce({ journalEntryId: 'je-2', prediction: {} as never, warnings: [W] });

    const r = await run([txRow('t1', -300, '2026-10-02'), txRow('t2', -115, '2026-10-03')], (call) => call === 1);

    expect(r.skipped).toEqual([{ txId: 't1', reason: 'tag failed' }]);
    expect(r.posted).toBe(1);
    expect(r.warnings).toEqual([{ txId: 't2', journalEntryId: 'je-2', label: `2026-10-03 ${formatCurrency(115)}`, description: 'EFT t2', warnings: [W] }]);
  });
});
