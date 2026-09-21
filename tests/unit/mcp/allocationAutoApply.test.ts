/**
 * The `auto_apply` switch on the allocation tools.
 *
 * The old description told an agent that cash was applied to no bill unless it
 * named an invoice_id, and that was true: the contact's strategy column
 * defaults to 'off'. Now the default is FIFO and the agent has to be able to
 * say 'none' — and to read back what its line actually closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [
    { vat_input_denied: false, account_code: '5410', account_name: 'Computer Expenses' },
  ]),
  getPoolForTests: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  getBankTransactionStatus: vi.fn(),
}));

import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { allocateBankTransactionTool } from '@/lib/mcp/tools/writeBankAllocate';
import { parseAllocationLine } from '@/lib/mcp/tools/allocationLine';

const ctx = { companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null } as never;
const TX = '045ef594-d81d-4f21-84d6-1151ed71260d';
const SUPPLIER = 'cf9df9b9-9fc0-424b-8137-47e9ba144c73';
const JE = '97120700-9f09-4fe5-804e-34331ce49b97';

function text(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
});

describe('parseAllocationLine — auto_apply', () => {
  it('defaults to fifo', () => {
    const line = parseAllocationLine({ transaction_id: TX, contra_account_id: SUPPLIER });
    expect(typeof line === 'string' ? line : line.autoApply).toBe('fifo');
  });

  it("accepts 'none'", () => {
    const line = parseAllocationLine({
      transaction_id: TX, contra_account_id: SUPPLIER, auto_apply: 'none',
    });
    expect(typeof line === 'string' ? line : line.autoApply).toBe('none');
  });

  it('refuses anything else rather than coercing it', () => {
    // inputSchema.enum is documentation; this array is the runtime gate.
    const refusal = parseAllocationLine({
      transaction_id: TX, contra_account_id: SUPPLIER, auto_apply: 'oldest',
    });
    expect(refusal).toBe('auto_apply must be one of: fifo, none');
  });
});

describe('allocate_bank_transaction — reporting what the cash closed', () => {
  it('passes the mode to the service and echoes the applications back', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: JE,
      bankTransaction: { id: TX },
      application: {
        autoApply: 'fifo',
        applications: [{ documentId: 'bill-1', documentNumber: 'INV-001', amount: 250 }],
        onAccount: 50,
      },
    } as never);

    const result = await allocateBankTransactionTool.handler(
      {
        transaction_id: TX, alloc_type: 'supplier', entity_id: SUPPLIER, idempotency_key: 'k1',
      },
      ctx,
    ) as { content: { text: string }[] };

    expect(vi.mocked(allocateTransaction).mock.calls[0]![12]).toMatchObject({
      autoApply: 'fifo',
    });
    const body = JSON.parse(text(result));
    expect(body.auto_apply).toBe('fifo');
    expect(body.applications).toEqual([
      { document_id: 'bill-1', document_number: 'INV-001', amount: 250 },
    ]);
    expect(body.on_account).toBe(50);
  });

  it("passes 'none' through and reports the whole line on account", async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: JE,
      bankTransaction: { id: TX },
      application: { autoApply: 'none', applications: [], onAccount: 300 },
    } as never);

    const result = await allocateBankTransactionTool.handler(
      {
        transaction_id: TX, alloc_type: 'supplier', entity_id: SUPPLIER,
        auto_apply: 'none', idempotency_key: 'k2',
      },
      ctx,
    ) as { content: { text: string }[] };

    expect(vi.mocked(allocateTransaction).mock.calls[0]![12]).toMatchObject({
      autoApply: 'none',
    });
    const body = JSON.parse(text(result));
    expect(body.applications).toEqual([]);
    expect(body.on_account).toBe(300);
  });

  it('says nothing about applications for a plain GL line', async () => {
    vi.mocked(allocateTransaction).mockResolvedValue({
      journalEntryId: JE, bankTransaction: { id: TX },
    } as never);

    const result = await allocateBankTransactionTool.handler(
      { transaction_id: TX, contra_account_id: SUPPLIER, idempotency_key: 'k3' },
      ctx,
    ) as { content: { text: string }[] };

    const body = JSON.parse(text(result));
    expect(body.applications).toBeUndefined();
    expect(body.on_account).toBeUndefined();
  });
});

describe('the tool descriptions', () => {
  it('tells the agent that cash applies FIFO unless it says otherwise', async () => {
    const { bulkAllocateBankTransactionsTool } = await import(
      '@/lib/mcp/tools/writeBankBulkAllocate'
    );
    for (const tool of [allocateBankTransactionTool, bulkAllocateBankTransactionsTool]) {
      expect(tool.description).toContain('auto_apply');
      expect(tool.description).toMatch(/oldest/i);
    }
  });
});
