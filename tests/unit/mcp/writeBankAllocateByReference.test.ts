/**
 * PRD-11 §5 — allocate/reverse by the reference printed on the bank statement.
 *
 * The agent reads a statement, not the database, so it holds `bank_reference`
 * and not a UUID. Resolution has to be exact and unambiguous: silently taking
 * the first of several same-reference rows would post this month's journal
 * against last month's transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  getBankTransactionStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));

import {
  allocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import {
  findBankTransactionsByReference,
  getBankTransactionStatus,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { allocateBankTransactionTool, reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

const MATCH_A = { id: '8102aa5c-6c28-4c30-8ae4-cbb89c5467a9', transactionDate: '2026-03-01', amount: -1234.56, description: 'ACME' };
const MATCH_B = { id: 'tx-b', transactionDate: '2026-04-01', amount: -1234.56, description: 'ACME' };

function text(res: { content: { text: string }[] }): string {
  return res.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the row exists and is in the state the tool under test needs. The
  // allocate/reverse handlers now answer their pre-write refusals from this
  // read, so the service call below can rethrow everything.
  vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(allocateTransaction).mockResolvedValue({
    journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '8102aa5c-6c28-4c30-8ae4-cbb89c5467a9' },
  } as never);
  vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined as never);
  vi.mocked(findBankTransactionsByReference).mockResolvedValue([MATCH_A]);
});

// The fourth column is the bank_transaction status each tool's PRE-WRITE check
// requires: allocate wants a row with nothing on it yet, reverse wants one with
// an allocation to undo. Both refusals moved out of a catch and into that read,
// so that everything the services throw can be rethrown for the savepoint.
describe.each([
  ['allocate_bank_transaction', allocateBankTransactionTool, { contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73' }, 'imported'],
  ['reverse_bank_allocation', reverseBankAllocationTool, {}, 'allocated'],
] as const)('%s — bank_reference resolution', (_name, tool, extra, status) => {
  beforeEach(() => { vi.mocked(getBankTransactionStatus).mockResolvedValue(status); });

  it('no longer demands transaction_id in the manifest, only the idempotency key', () => {
    expect(tool.inputSchema.required).toEqual(['idempotency_key']);
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.bank_reference).toBeDefined();
    expect(props.bank_account_id).toBeDefined();
  });

  it('resolves a unique bank_reference within the token company', async () => {
    const res = await tool.handler({ bank_reference: 'REF-001', idempotency_key: 'k1', ...extra }, ctx);

    expect(res.isError).toBeFalsy();
    expect(findBankTransactionsByReference).toHaveBeenCalledWith('company-1', 'REF-001', undefined);
  });

  it('passes bank_account_id through as a narrowing filter', async () => {
    await tool.handler(
      { bank_reference: 'REF-001', bank_account_id: 'f60ea224-2740-48f8-8eeb-c594e67305aa', idempotency_key: 'k1', ...extra }, ctx,
    );
    expect(findBankTransactionsByReference).toHaveBeenCalledWith('company-1', 'REF-001', 'f60ea224-2740-48f8-8eeb-c594e67305aa');
  });

  it('trims the reference before resolving', async () => {
    await tool.handler({ bank_reference: '  REF-001  ', idempotency_key: 'k1', ...extra }, ctx);
    expect(findBankTransactionsByReference).toHaveBeenCalledWith('company-1', 'REF-001', undefined);
  });

  it('rejects a call carrying neither transaction_id nor bank_reference', async () => {
    const res = await tool.handler({ idempotency_key: 'k1', ...extra }, ctx);
    expect(res.isError).toBe(true);
    expect(findBankTransactionsByReference).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('rejects a call carrying BOTH — the two could name different rows', async () => {
    const res = await tool.handler(
      { transaction_id: 'bc832863-424e-4a35-85ef-f8185ca28cbc', bank_reference: 'REF-001', idempotency_key: 'k1', ...extra }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(findBankTransactionsByReference).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('reports an unmatched reference with the same text as a tenant miss — no existence oracle', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([]);

    const res = await tool.handler({ bank_reference: 'REF-404', idempotency_key: 'k1', ...extra }, ctx);

    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Not found');
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous reference and lists the candidates instead of guessing', async () => {
    vi.mocked(findBankTransactionsByReference).mockResolvedValue([MATCH_A, MATCH_B]);

    const res = await tool.handler({ bank_reference: 'REF-DUP', idempotency_key: 'k1', ...extra }, ctx);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('bank_reference is ambiguous');
    // The agent must be able to pick: ids, dates and amounts all present.
    for (const frag of ['8102aa5c-6c28-4c30-8ae4-cbb89c5467a9', 'tx-b', '2026-03-01', '2026-04-01', '1234.56']) {
      expect(text(res)).toContain(frag);
    }
    // Mutation guard: returning matches[0] here instead of erroring must fail.
    expect(allocateTransaction).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('still accepts a plain transaction_id — the existing call shape is unbroken', async () => {
    const res = await tool.handler({ transaction_id: 'f3d54cf4-8108-435b-8fe3-791a5c418be5', idempotency_key: 'k1', ...extra }, ctx);
    expect(res.isError).toBeFalsy();
    expect(findBankTransactionsByReference).not.toHaveBeenCalled();
  });

  it('tells the agent in its description that a statement reference is accepted', () => {
    expect(tool.description).toContain('bank_reference');
  });
});

describe('allocate_bank_transaction — resolved id reaches the service', () => {
  it('allocates the resolved transaction, not the reference string', async () => {
    await allocateBankTransactionTool.handler(
      { bank_reference: 'REF-001', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', idempotency_key: 'k1' }, ctx,
    );
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect(call[0]).toBe('company-1');
    expect(call[1]).toBe('8102aa5c-6c28-4c30-8ae4-cbb89c5467a9');
  });

  it('resolves the reference only after the argument validation gates', async () => {
    const res = await allocateBankTransactionTool.handler(
      { bank_reference: 'REF-001', alloc_type: 'supplier', idempotency_key: 'k1' }, ctx,
    );
    expect(res.isError).toBe(true); // entity_id missing
    expect(findBankTransactionsByReference).not.toHaveBeenCalled();
  });
});

describe('reverse_bank_allocation — resolved id reaches the service', () => {
  beforeEach(() => { vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated'); });

  it('reverses the resolved transaction and reports its id', async () => {
    const res = await reverseBankAllocationTool.handler(
      { bank_reference: 'REF-001', idempotency_key: 'k1' }, ctx,
    );
    const call = vi.mocked(reverseReconciledTransaction).mock.calls[0]!;
    expect(call[1]).toBe('8102aa5c-6c28-4c30-8ae4-cbb89c5467a9');
    expect(JSON.parse(text(res))).toMatchObject({ transaction_id: '8102aa5c-6c28-4c30-8ae4-cbb89c5467a9', reversed: true });
  });
});
