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

    expect(reverseReconciledTransaction).toHaveBeenCalledWith('company-1', 'tx-1', 'user-1');
    expect(res.isError).toBeFalsy();
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
