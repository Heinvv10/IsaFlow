/**
 * What `importParsedTransactions` hands back of the cost-centre picks its
 * auto-post sweep could not apply (PR #688 follow-up F3): `autoPostWarnings`
 * when the sweep reported any, nothing when it did not, nothing when the
 * savepoint around the sweep rolled back after it returned them (the journals
 * they name went with it), and a sweep answer missing the list is not an
 * auto-post failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { withTransactionMock, sqlMock, savepointMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
  savepointMock: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  transaction: vi.fn(),
  withTransaction: withTransactionMock,
  withSavepoint: savepointMock,
  assertTxUsable: () => {},
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  sweep: vi.fn().mockResolvedValue({ runId: null, posted: 0, skipped: [], warnings: [] }),
}));
vi.mock('@/modules/accounting/services/bank/bankTransferLinkService', () => ({
  relinkTransferCounterparts: vi.fn().mockResolvedValue({ linked: 0, passes: 0, failed: false }),
  autoLinkImportedBatchTransfers: vi.fn().mockResolvedValue({ linked: 0, passes: 0, failed: false }),
}));

import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import type { BankCsvParseResult } from '@/modules/accounting/types/bank.types';

const parsed = (): BankCsvParseResult => ({
  transactions: [
    { transactionDate: '2025-01-15', amount: -100, description: 'Coffee' },
    { transactionDate: '2025-01-16', amount: -50, description: 'Tea' },
  ],
  bankFormat: 'absa', accountNumber: '123456789', errors: [],
});
const W = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const dropped = [{ txId: 'tx-outflow-1', journalEntryId: 'je-1', label: '2025-01-15 R100.00', warnings: [W] }];
const run = () => importParsedTransactions('company-1', parsed(), 'gl-bank-acct-1', '2025-01-31');

describe('importParsedTransactions — the picks the auto-post dropped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock.mockReset();
    // Non-empty: the sweep only runs when the outflow SELECT returns rows.
    sqlMock.mockResolvedValue([{ id: 'tx-outflow-1' }]);
    withTransactionMock.mockReset();
    withTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(() => Promise.resolve([])));
  });

  it('hands back the picks the sweep dropped, and nothing when it dropped none', async () => {
    vi.mocked(sweep).mockResolvedValueOnce({ runId: 'run-1', posted: 1, skipped: [], warnings: dropped });
    expect((await run()).autoPostWarnings).toEqual(dropped);
    expect(await run()).not.toHaveProperty('autoPostWarnings');
  });

  it('hands back no picks when the savepoint around the sweep rolled back after it returned them', async () => {
    vi.mocked(sweep).mockResolvedValueOnce({ runId: 'run-1', posted: 1, skipped: [], warnings: dropped });
    savepointMock.mockImplementationOnce(async (_name, fn) => { await fn(); throw new Error('RELEASE failed'); });

    const result = await run();

    expect(result).not.toHaveProperty('autoPostWarnings');
    expect(result.errors.map((e) => e.error)).toEqual([expect.stringMatching(/Auto-posting of imported outflows failed/)]);
  });

  it('a sweep answer without a warnings list is not an auto-post failure: its posts stand', async () => {
    // Throwing on its absence would roll the savepoint back and take the posted journals with it.
    vi.mocked(sweep).mockResolvedValueOnce({ runId: 'run-1', posted: 1, skipped: [] } as never);

    const result = await run();

    expect(result.errors).toEqual([]);
    expect(result).not.toHaveProperty('autoPostWarnings');
  });
});
