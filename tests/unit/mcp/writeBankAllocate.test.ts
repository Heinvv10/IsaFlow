import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));

import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { allocateBankTransactionTool } from '@/lib/mcp/tools/writeBankAllocate';

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
