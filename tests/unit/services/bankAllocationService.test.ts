/**
 * BL-05: Unit tests for bankAllocationService VAT allocation paths.
 *
 * These tests verify that:
 * 1. When account_subtype = 'vat_input' / 'vat_output' exists (post-migration),
 *    allocations with vatCode='standard' succeed and produce correct journal lines.
 * 2. The fallback to account_code '1140'/'2120' fires when the subtype lookup
 *    returns nothing (legacy COA edge case) and surfaces a warning.
 * 3. When neither subtype nor account_code resolves, a clear error is thrown.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

// fmtDate is a pure date formatter (no DB) — keep the real one so the
// allocation date under test is the one production renders.
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), withTransaction: vi.fn(), fmtDate: actual.fmtDate };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

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

// ── Imports ───────────────────────────────────────────────────────────────────

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const mockSql = sql as unknown as SqlFn;
const mockWithTx = withTransaction as unknown as MockedFunction<
  (fn: (wTx: unknown) => Promise<void>) => Promise<void>
>;
const mockGetSystemAccountId = getSystemAccountId as MockedFunction<typeof getSystemAccountId>;
const mockCreateJE = createJournalEntry as MockedFunction<typeof createJournalEntry>;
const mockPostJE = postJournalEntry as MockedFunction<typeof postJournalEntry>;
const mockLog = log as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'; // Brightsphere
const BANK_TX_ID = 'btx-0000-0000-0000-000000000001';
const BANK_ACCOUNT_ID = 'ba-0000-0000-0000-000000000001';
const CONTRA_ACCOUNT_ID = 'acct-0000-0000-0000-expenses001';
const USER_ID = '00000000-0000-0000-0000-000000000001';
const VAT_INPUT_ID = 'vatinput-0000-0000-0000-000000000001';
const JE_ID = 'je-0000-0000-0000-000000000001';
const JL_ID = 'jl-0000-0000-0000-000000000001';

/** A bank debit (money out / expense) for R115 so VAT math is easy at 15%. */
const BANK_TX_ROW = {
  id: BANK_TX_ID,
  bank_account_id: BANK_ACCOUNT_ID,
  amount: -115,
  transaction_date: new Date('2026-02-28'),
  status: 'imported',
  description: 'Test expense',
  reference: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupHappyPath() {
  // sql returns: bank tx row, then contra account lookup, then je line lookup, then final tx
  mockSql
    .mockResolvedValueOnce([BANK_TX_ROW])                             // fetch bank tx
    .mockResolvedValueOnce([{ account_code: '6000', account_name: 'Expenses' }]) // contra lookup
    .mockResolvedValueOnce([{ id: JL_ID }])                           // je lines lookup
    .mockResolvedValueOnce([BANK_TX_ROW]);                             // final fetch

  mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue(undefined)); });

  mockGetSystemAccountId
    .mockResolvedValue(VAT_INPUT_ID);       // vat_input lookup (account path only calls this)

  mockCreateJE.mockResolvedValue({
    id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-02-28',
    description: 'Test expense', status: 'draft', source: 'auto_bank_recon',
  } as unknown as ReturnType<typeof createJournalEntry> extends Promise<infer R> ? R : never);

  mockPostJE.mockResolvedValue(undefined);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bankAllocationService — VAT allocation (BL-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('allocateTransaction — vatCode=standard (money out)', () => {
    it('succeeds when vat_input system account exists (post-migration state)', async () => {
      setupHappyPath();

      // Import lazily so mocks are in place
      const { allocateTransaction } = await import(
        '@/modules/accounting/services/bank/bankAllocationService'
      );

      const result = await allocateTransaction(
        COMPANY_ID, BANK_TX_ID, CONTRA_ACCOUNT_ID, USER_ID,
        'Test expense', 'account', undefined, 'standard',
      );

      // Should have returned a result with a journal entry id
      expect(result.journalEntryId).toBe(JE_ID);

      // getSystemAccountId should have been called for vat_input
      expect(mockGetSystemAccountId).toHaveBeenCalledWith('vat_input', COMPANY_ID);

      // createJournalEntry should have been called with VAT lines
      expect(mockCreateJE).toHaveBeenCalledOnce();
      const [, jeInput] = mockCreateJE.mock.calls[0]!;
      // Lines: contra (net), VAT line, bank credit
      expect(jeInput.lines).toHaveLength(3);
      const vatLine = jeInput.lines.find(
        (l: { glAccountId: string }) => l.glAccountId === VAT_INPUT_ID
      );
      expect(vatLine).toBeDefined();
      // For R115 debit, net = R100, VAT = R15
      expect(vatLine.debit).toBeCloseTo(15, 2);
    });
  });

  describe('allocateTransaction — no VAT (vatCode undefined)', () => {
    it('succeeds without touching VAT accounts when vatCode is not standard', async () => {
      mockSql
        .mockResolvedValueOnce([BANK_TX_ROW])
        .mockResolvedValueOnce([{ account_code: '6000', account_name: 'Expenses' }])
        .mockResolvedValueOnce([{ id: JL_ID }])
        .mockResolvedValueOnce([BANK_TX_ROW]);

      mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue(undefined)); });
      mockGetSystemAccountId.mockResolvedValue('some-id');

      mockCreateJE.mockResolvedValue({
        id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-02-28',
        description: 'Test expense', status: 'draft', source: 'auto_bank_recon',
      } as unknown as ReturnType<typeof createJournalEntry> extends Promise<infer R> ? R : never);
      mockPostJE.mockResolvedValue(undefined);

      const { allocateTransaction } = await import(
        '@/modules/accounting/services/bank/bankAllocationService'
      );

      const result = await allocateTransaction(
        COMPANY_ID, BANK_TX_ID, CONTRA_ACCOUNT_ID, USER_ID,
        'No VAT expense', 'account', undefined, undefined,
      );

      expect(result.journalEntryId).toBe(JE_ID);
      // getSystemAccountId should NOT have been called for vat_input / vat_output
      const vatCalls = mockGetSystemAccountId.mock.calls.filter(
        ([key]) => key === 'vat_input' || key === 'vat_output'
      );
      expect(vatCalls).toHaveLength(0);
    });
  });

  describe('bankAllocationService — fallback to account_code when subtype missing', () => {
    it('falls back to account_code 1140 when vat_input subtype lookup fails', async () => {
      // getSystemAccountId throws for vat_input (old subtype not yet migrated)
      mockGetSystemAccountId.mockImplementation(async (key: string) => {
        if (key === 'vat_input') {
          throw new Error(`System account with subtype 'vat_input' not found for company ${COMPANY_ID}`);
        }
        return 'some-account-id';
      });

      // sql: bank tx, contra lookup, THEN the fallback code-based lookup returns a row
      const FALLBACK_ROW = { id: 'fallback-vat-input-id' };
      mockSql
        .mockResolvedValueOnce([BANK_TX_ROW])
        .mockResolvedValueOnce([{ account_code: '6000', account_name: 'Expenses' }])
        .mockResolvedValueOnce([FALLBACK_ROW])   // fallback code='1140' lookup
        .mockResolvedValueOnce([{ id: JL_ID }])  // je lines
        .mockResolvedValueOnce([BANK_TX_ROW]);    // final fetch

      mockWithTx.mockImplementation(async (fn) => { await fn(vi.fn().mockResolvedValue(undefined)); });
      mockCreateJE.mockResolvedValue({
        id: JE_ID, companyId: COMPANY_ID, entryDate: '2026-02-28',
        description: 'Test expense', status: 'draft', source: 'auto_bank_recon',
      } as unknown as ReturnType<typeof createJournalEntry> extends Promise<infer R> ? R : never);
      mockPostJE.mockResolvedValue(undefined);

      const { allocateTransaction } = await import(
        '@/modules/accounting/services/bank/bankAllocationService'
      );

      const result = await allocateTransaction(
        COMPANY_ID, BANK_TX_ID, CONTRA_ACCOUNT_ID, USER_ID,
        'Test expense', 'account', undefined, 'standard',
      );

      expect(result.journalEntryId).toBe(JE_ID);

      // Warning should have been logged about the fallback
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('fallback'),
        expect.objectContaining({ companyId: COMPANY_ID }),
        expect.any(String),
      );

      // Fallback account should appear in journal lines
      const [, jeInput] = mockCreateJE.mock.calls[0]!;
      const fallbackLine = jeInput.lines.find(
        (l: { glAccountId: string }) => l.glAccountId === 'fallback-vat-input-id'
      );
      expect(fallbackLine).toBeDefined();
    });

    it('throws a clear error when both subtype and account_code fallback fail', async () => {
      mockGetSystemAccountId.mockImplementation(async (key: string) => {
        if (key === 'vat_input') {
          throw new Error(`System account with subtype 'vat_input' not found`);
        }
        return 'some-account-id';
      });

      // sql: bank tx, contra lookup, THEN fallback returns empty
      mockSql
        .mockResolvedValueOnce([BANK_TX_ROW])
        .mockResolvedValueOnce([{ account_code: '6000', account_name: 'Expenses' }])
        .mockResolvedValueOnce([]); // fallback also returns nothing

      const { allocateTransaction } = await import(
        '@/modules/accounting/services/bank/bankAllocationService'
      );

      await expect(
        allocateTransaction(
          COMPANY_ID, BANK_TX_ID, CONTRA_ACCOUNT_ID, USER_ID,
          'Test expense', 'account', undefined, 'standard',
        )
      ).rejects.toThrow(/VAT Input system account not found/);
    });
  });
});
