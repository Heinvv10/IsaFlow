/**
 * PRD-11 §5 — the allocation date must not roll back a day.
 *
 * pg hands `transaction_date` back as a JS Date at LOCAL midnight. On the
 * UTC+2 production box, `toISOString().split('T')[0]` applied to
 * 2026-03-01T00:30+02:00 renders "2026-02-28": the journal — and the
 * customer_payments row that mirrors it — land in the wrong month, and at a
 * period boundary in an already-closed period. `fmtDate` from @/lib/neon reads
 * the local Y/M/D components instead.
 *
 * TZ is pinned so the assertion means the same thing on a UTC CI runner as it
 * does on the SAST server the defect was reported from.
 */
process.env.TZ = 'Africa/Johannesburg';

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  // withSavepoint passes through: R-067's tenant fence runs its ownership read
  // inside one, and an undefined mock would make every customer allocation throw.
  return {
    sql: vi.fn(),
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => Promise.resolve().then(fn)),
    fmtDate: actual.fmtDate,
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  mapTxRow: vi.fn((row: unknown) => row),
}));

// This file is about the DATE the journal and the receipt carry. Applying the
// receipt afterwards is a different concern with its own file, and left real it
// would consume the mocked `sql` queue below.
vi.mock('@/modules/accounting/services/ar/customerAutoAllocate', () => ({
  autoApplyCustomerReceipt: vi.fn(async () => ({
    appliedLines: [], unappliedRemainder: 0, strategy: 'off',
  })),
}));

import { sql, withTransaction } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

// The bank write paths take a row lock (bankTxLock), which refuses to run
// outside a request transaction. These tests mock `sql`, so the ALS client is
// never actually used — it only has to be present.
beforeEach(() => enterFakeRequestCtx());


type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const mockSql = sql as unknown as SqlFn;
const mockWithTx = withTransaction as unknown as MockedFunction<
  (fn: (wTx: unknown) => Promise<void>) => Promise<void>
>;
const mockGetSystemAccountId = getSystemAccountId as MockedFunction<typeof getSystemAccountId>;
const mockCreateJE = createJournalEntry as MockedFunction<typeof createJournalEntry>;
const mockPostJE = postJournalEntry as MockedFunction<typeof postJournalEntry>;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const BANK_TX_ID = 'btx-0000-0000-0000-000000000001';
const BANK_ACCOUNT_ID = 'ba-0000-0000-0000-000000000001';
const CONTRA_ACCOUNT_ID = 'acct-0000-0000-0000-expenses001';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = '11111111-2222-3333-4444-555555555555';
const JE_ID = 'je-0000-0000-0000-000000000001';
const JL_ID = 'jl-0000-0000-0000-000000000001';

/** 2026-03-01T00:30:00+02:00 — the instant that rolls back a day under UTC. */
const SAST_EARLY_MORNING = new Date('2026-02-28T22:30:00Z');

const TX_ROW = {
  id: BANK_TX_ID,
  bank_account_id: BANK_ACCOUNT_ID,
  amount: -115,
  transaction_date: SAST_EARLY_MORNING,
  status: 'imported',
  description: 'Test expense',
  reference: null,
};

describe('bankAllocationService — allocation date survives UTC rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue([{ id: 'cp-1' }])); });
    mockPostJE.mockResolvedValue(undefined);
    mockGetSystemAccountId.mockResolvedValue('sys-account-id');
    mockCreateJE.mockResolvedValue({
      id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-03-01',
      description: 'Test expense', status: 'draft', source: 'auto_bank_recon',
    } as never);
  });

  it('dates the journal 2026-03-01 for a 00:30 SAST transaction (account allocation)', async () => {
    mockSql
      .mockResolvedValueOnce([TX_ROW])
      .mockResolvedValueOnce([{ account_code: '6000', account_name: 'Expenses' }])
      .mockResolvedValueOnce([{ id: JL_ID }])
      .mockResolvedValueOnce([TX_ROW]);

    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await allocateTransaction(COMPANY_ID, BANK_TX_ID, CONTRA_ACCOUNT_ID, USER_ID, 'Test expense');

    const [, jeInput] = mockCreateJE.mock.calls[0]!;
    expect(jeInput.entryDate).toBe('2026-03-01');
  });

  it('dates the journal 2026-03-01 for a 00:30 SAST transaction (split allocation)', async () => {
    mockSql
      .mockResolvedValueOnce([TX_ROW])
      .mockResolvedValueOnce([{ id: JL_ID }])
      .mockResolvedValueOnce([TX_ROW]);

    const { splitAllocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await splitAllocateTransaction(
      COMPANY_ID, BANK_TX_ID, [{ contraAccountId: CONTRA_ACCOUNT_ID, amount: 115 }], USER_ID,
    );

    const [, jeInput] = mockCreateJE.mock.calls[0]!;
    expect(jeInput.entryDate).toBe('2026-03-01');
  });

  it('binds payment_date = 2026-03-01 on the customer_payments INSERT', async () => {
    const receiptRow = { ...TX_ROW, amount: 115 }; // money in → customer receipt path
    mockSql
      .mockResolvedValueOnce([receiptRow])                 // fetch bank tx
      .mockResolvedValueOnce([{ ok: 1 }])                  // R-067 tenant fence on entityId
      .mockResolvedValueOnce([{ name: 'Acme (Pty) Ltd' }]) // customers lookup
      .mockResolvedValueOnce([])                           // customer_invoices source doc
      .mockResolvedValueOnce([{ id: JL_ID }])              // je line lookup
      .mockResolvedValueOnce([receiptRow]);                // final fetch

    // Returns rows: the customer_payments INSERT reads its id back so the
    // receipt can be applied.
    const wTx = vi.fn().mockResolvedValue([{ id: 'cp-1' }]);
    mockWithTx.mockImplementation(async (fn) => { await fn(wTx); });

    const { allocateTransaction } = await import(
      '@/modules/accounting/services/bank/bankAllocationService'
    );
    await allocateTransaction(
      COMPANY_ID, BANK_TX_ID, null, USER_ID, 'Receipt', 'customer', CUSTOMER_ID,
    );

    const insertCall = wTx.mock.calls.find((c: unknown[]) =>
      (c[0] as string[]).join('').includes('INSERT INTO customer_payments'));
    expect(insertCall).toBeDefined();

    const dateParams = (insertCall as unknown[]).slice(1)
      .filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
    expect(dateParams).toContain('2026-03-01');
    expect(dateParams).not.toContain('2026-02-28');
  });
});
