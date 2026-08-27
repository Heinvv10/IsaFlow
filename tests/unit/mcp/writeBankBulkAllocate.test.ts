/**
 * PRD-11 §4 — bulk_allocate_bank_transactions: everything refused BEFORE the
 * first write.
 *
 * Shape, size, duplicates, tenant ownership and dry_run all resolve before any
 * journal is posted, so each must come back as a precise toolError — there is
 * nothing to roll back, and a generic failure would leave the agent guessing
 * which of 500 lines was wrong. The posting path and the all-or-nothing
 * rollback live in writeBankBulkAllocate.posting.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationBatchService', () => ({
  createAllocationBatch: vi.fn(),
  stampAllocationBatch: vi.fn(),
  getAllocationBatchTransactionIds: vi.fn(),
  clearAllocationBatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));

import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import {
  createAllocationBatch,
  stampAllocationBatch,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const BATCH = 'batch-1';

function payload(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

function line(n: number): Record<string, unknown> {
  return { transaction_id: `tx-${n}`, contra_account_id: 'acc-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(createAllocationBatch).mockResolvedValue(BATCH);
  vi.mocked(stampAllocationBatch).mockResolvedValue(undefined);
  vi.mocked(allocateTransaction).mockImplementation(
    (async (_c: string, txId: string) => ({
      journalEntryId: `je-for-${txId}`,
      bankTransaction: { id: txId },
    })) as never,
  );
});

describe('bulk_allocate_bank_transactions — surface', () => {
  it('posts journals, so it demands write:post and an idempotency key', () => {
    expect(bulkAllocateBankTransactionsTool.name).toBe('bulk_allocate_bank_transactions');
    expect(bulkAllocateBankTransactionsTool.scope).toBe('write:bank-tx');
    expect(bulkAllocateBankTransactionsTool.write).toBe(true);
    expect(bulkAllocateBankTransactionsTool.requiresPost).toBe(true);
    expect(bulkAllocateBankTransactionsTool.inputSchema.required).toContain('idempotency_key');
    expect(bulkAllocateBankTransactionsTool.inputSchema.required).toContain('allocations');
  });
});

describe('bulk_allocate_bank_transactions — pre-write refusals', () => {
  it('refuses an empty batch without opening one', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [], idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses more than 500 lines before any ownership query runs', async () => {
    const allocations = Array.from({ length: 501 }, (_, i) => line(i));
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/500/);
    expect(accountsBelongToCompany).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a duplicated transaction id — the second line would post against an already-allocated row', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2), line(1)], idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/tx-1/);
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(createAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a duplicate that only appears once the bank_reference is resolved', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([
      { id: 'tx-1', transactionDate: '2026-08-01', amount: -100, description: null },
    ]);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { bank_reference: 'REF1', contra_account_id: 'acc-1' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a line naming both a transaction_id and a bank_reference', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', bank_reference: 'REF1', contra_account_id: 'acc-1' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('names the offending line index so the agent can fix 1 of 500', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { transaction_id: 'tx-2', alloc_type: 'transfer' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/allocations\[1\]/);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });
});

// The pre-extraction handler passed args.invoice_id through raw; the shared
// parser trims it like every other id on the line. '' was already falsy and
// behaved the same, but '  ' was not — it reached allocateTransaction as a
// literal two-space string to match invoice ids against. This pins the change.
describe('bulk_allocate_bank_transactions — field coercion', () => {
  it('treats a whitespace-only invoice_id as absent, not as a two-space id', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [{ transaction_id: 'tx-1', contra_account_id: 'acc-1', invoice_id: '  ' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(vi.mocked(allocateTransaction).mock.calls[0]![11]).toBeUndefined();
  });

  it('trims a real invoice_id rather than passing the padding to the matcher', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [{ transaction_id: 'tx-1', contra_account_id: 'acc-1', invoice_id: ' inv-1 ' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(vi.mocked(allocateTransaction).mock.calls[0]![11]).toBe('inv-1');
  });
});

describe('bulk_allocate_bank_transactions — tenant ownership', () => {
  it('checks every contra account in ONE query, not one per line', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [
          { transaction_id: 'tx-1', contra_account_id: 'acc-1' },
          { transaction_id: 'tx-2', contra_account_id: 'acc-2' },
          { transaction_id: 'tx-3', contra_account_id: 'acc-1' },
        ],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(accountsBelongToCompany).toHaveBeenCalledTimes(1);
    const [company, ids] = vi.mocked(accountsBelongToCompany).mock.calls[0]!;
    expect(company).toBe('company-1');
    expect([...(ids as string[])].sort()).toEqual(['acc-1', 'acc-2']);
  });

  it('refuses a foreign contra account with the generic NOT_FOUND text and posts nothing', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), { transaction_id: 'tx-2', contra_account_id: 'company-B-account' }], idempotency_key: 'k1' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(createAllocationBatch).not.toHaveBeenCalled();
  });

  it('refuses a foreign supplier entity and posts nothing', async () => {
    vi.mocked(suppliersBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', alloc_type: 'supplier', entity_id: 'company-B-supplier' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('refuses a foreign customer entity and posts nothing', async () => {
    vi.mocked(customersBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: 'tx-1', alloc_type: 'customer', entity_id: 'company-B-customer' }],
        idempotency_key: 'k1',
      },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('reads the tenant from ctx only — a company_id in the args is ignored', async () => {
    await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], company_id: 'company-B', idempotency_key: 'k1' }, ctx,
    );
    expect(vi.mocked(allocateTransaction).mock.calls[0]![0]).toBe('company-1');
    expect(vi.mocked(createAllocationBatch).mock.calls[0]![0]).toBe('company-1');
  });
});

describe('bulk_allocate_bank_transactions — dry run', () => {
  it('writes nothing at all: no batch, no allocation', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1), line(2)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(createAllocationBatch).not.toHaveBeenCalled();
    expect(stampAllocationBatch).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('returns the resolved lines it would post, with no batch id', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([
      { id: 'tx-9', transactionDate: '2026-08-01', amount: -100, description: null },
    ]);
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [line(1), { bank_reference: 'REF9', contra_account_id: 'acc-2' }],
        dry_run: true,
        idempotency_key: 'k1',
      },
      ctx,
    );
    const body = payload(res as never);
    expect(body.dry_run).toBe(true);
    expect(body.batch_id).toBeNull();
    expect(body.posted).toBe(0);
    expect(body.lines).toEqual([
      expect.objectContaining({ transaction_id: 'tx-1', contra_account_id: 'acc-1', alloc_type: 'account' }),
      expect.objectContaining({ transaction_id: 'tx-9', contra_account_id: 'acc-2', alloc_type: 'account' }),
    ]);
  });

  it('still refuses a dry run whose ids belong to another tenant', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [line(1)], dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });
});
