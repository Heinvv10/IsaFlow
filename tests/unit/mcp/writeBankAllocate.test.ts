import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));

import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { allocateBankTransactionTool, reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('allocate_bank_transaction', () => {
  it('demands the write:post permission — it posts a journal, not a suggestion', () => {
    expect(allocateBankTransactionTool.scope).toBe('write:bank-tx');
    expect(allocateBankTransactionTool.requiresPost).toBe(true);
    expect(allocateBankTransactionTool.write).toBe(true);
    expect(allocateBankTransactionTool.inputSchema.required).toContain('idempotency_key');
  });

  it('stamps the posting agent so the write is attributable and reversible as a set', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: 'je-1', bankTransaction: { id: 'tx-1' },
    } as never);

    await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', idempotency_key: 'k1' },
      ctx,
    );

    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');           // tenant from ctx
    expect(call[3]).toBe('user-1');
    expect(call[12]).toEqual({ postingAgent: 'mcp:allocate_bank_transaction:v1' });
  });

  it('rejects a missing transaction_id without touching the ledger', async () => {
    const res = await allocateBankTransactionTool.handler(
      { contra_account_id: 'acc-1', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('surfaces the service refusal for an already-allocated transaction', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      new Error('Transaction already allocated — cannot allocate'),
    );

    const res = await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', idempotency_key: 'k1' }, ctx,
    );

    expect(res.isError).toBe(true);
  });

  it('rejects alloc_type "transfer" — undocumented, live bank-to-bank-transfer semantics — without touching the ledger', async () => {
    const res = await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'transfer', idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('accepts a valid alloc_type and passes it through to the service', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: 'je-1', bankTransaction: { id: 'tx-1' },
    } as never);

    const res = await allocateBankTransactionTool.handler(
      {
        transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'supplier',
        entity_id: 'sup-1', idempotency_key: 'k1',
      },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[5]).toBe('supplier');
  });

  // ── Finding 3: vat_code is validated at runtime, not just in the manifest ──
  // bankAllocationService maps an unrecognised vat_code to `undefined`, which
  // posts the line with NO vatType at all: a silently lost VAT201
  // classification on a journal that still balances.
  it.each(['zero-rated', 'ZERO_RATED', 'vat', ''])(
    'rejects the unrecognised vat_code %j rather than silently posting with no VAT type',
    async (bad) => {
      const res = await allocateBankTransactionTool.handler(
        { transaction_id: 'tx-1', contra_account_id: 'acc-1', vat_code: bad, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(allocateTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(['standard', 'zero_rated', 'exempt', 'none'])(
    'accepts the documented vat_code %j and passes it through unchanged',
    async (code) => {
      vi.mocked(allocateTransaction).mockResolvedValue({
        journalEntryId: 'je-1', bankTransaction: { id: 'tx-1' },
      } as never);

      const res = await allocateBankTransactionTool.handler(
        { transaction_id: 'tx-1', contra_account_id: 'acc-1', vat_code: code, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(vi.mocked(allocateTransaction).mock.calls[0]![7]).toBe(code);
    },
  );

  it('keeps the manifest enum and the runtime gate in sync for vat_code', () => {
    const props = allocateBankTransactionTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.vat_code?.enum).toEqual(['standard', 'zero_rated', 'exempt', 'none']);
  });

  // ── Finding 4: entity_id is required for supplier/customer ────────────────
  // Without it, allocateTransaction falls through to the plain GL-account
  // branch: a structurally different journal (no AP/AR control account, no
  // match) returned as a SUCCESS. The REST route over the same service guards
  // this explicitly (bank-transactions-action.ts).
  it.each(['supplier', 'customer'])(
    'rejects a %s allocation with no entity_id instead of posting a different journal',
    async (allocType) => {
      const res = await allocateBankTransactionTool.handler(
        { transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: allocType, idempotency_key: 'k1' },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(allocateTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects a blank entity_id for a supplier allocation — whitespace is not an entity', async () => {
    const res = await allocateBankTransactionTool.handler(
      {
        transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'supplier',
        entity_id: '   ', idempotency_key: 'k1',
      },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('still allows an account allocation without entity_id', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: 'je-1', bankTransaction: { id: 'tx-1' },
    } as never);

    const res = await allocateBankTransactionTool.handler(
      { transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'account', idempotency_key: 'k1' },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(allocateTransaction).toHaveBeenCalled();
  });
});

describe('reverse_bank_allocation', () => {
  it('is a write behind the write:post permission and demands an idempotency key', () => {
    expect(reverseBankAllocationTool.scope).toBe('write:bank-tx');
    expect(reverseBankAllocationTool.requiresPost).toBe(true);
    expect(reverseBankAllocationTool.write).toBe(true);
    expect(reverseBankAllocationTool.inputSchema.required).toContain('idempotency_key');
  });

  it('reverses using the tenant from ctx', async () => {
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: 'tx-1', idempotency_key: 'k9' }, ctx,
    );

    const call = vi.mocked(reverseReconciledTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');
    expect(call[1]).toBe('tx-1');
    expect(call[2]).toBe('user-1');
    expect(res.isError).toBeFalsy();
  });

  // ── Finding 1: the correction must not escape attribution ─────────────────
  // The reversal posts a REAL contra journal. Left unstamped it lands as
  // human:<userId> and disappears from list_agent_postings — the corrective
  // mechanism the whole attribution safety model leans on would be the one
  // operation the review surface cannot see.
  it('stamps the contra journal with the reversal tool, not the human default', async () => {
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    await reverseBankAllocationTool.handler(
      { transaction_id: 'tx-1', idempotency_key: 'k9' }, ctx,
    );

    expect(vi.mocked(reverseReconciledTransaction).mock.calls[0]![3]).toEqual({
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });
  });

  it('surfaces the refusal when the transaction is not in a reversible state', async () => {
    vi.mocked(reverseReconciledTransaction).mockRejectedValue(
      new Error('Can only reverse allocated, matched, or reconciled transactions'),
    );

    const res = await reverseBankAllocationTool.handler(
      { transaction_id: 'tx-1', idempotency_key: 'k9' }, ctx,
    );

    expect(res.isError).toBe(true);
  });
});
