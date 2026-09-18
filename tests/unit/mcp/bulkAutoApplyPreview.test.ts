/**
 * The bulk dry run's FIFO preview.
 *
 * A batch posts its lines in order against one set of open bills, so the
 * preview has to consume them in the same order. A preview that measured every
 * line against the opening balances would promise two lines the same bill and
 * then disagree with the batch it previewed — the failure
 * `docs/mcp/CONTRACTS.md` §6 calls worse than having no dry run at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({
  resolveRuleVatCode: vi.fn(async (input: { requestedVatCode: string }) => ({
    vatCode: input.requestedVatCode, denied: false, nonSupplyCoerced: false,
  })),
}));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  fetchVatDenialFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/nonSupplyVatGuard', () => ({
  fetchAccountNames: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/bankContraVat', () => ({
  fetchBankContraFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  findBankTransactionAllocationStates: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationBatchService', () => ({
  createAllocationBatch: vi.fn(),
  recordAllocationBatchLines: vi.fn(),
  getAllocationBatchLines: vi.fn(),
  clearAllocationBatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({
  resolveSupplierAutoAllocateStrategy: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerAutoAllocate', () => ({
  resolveCustomerAutoAllocateStrategy: vi.fn(),
}));
// The preview reads the open documents through the FETCH modules, not through
// the services above: it must not take the row locks those services ask for.
vi.mock('@/modules/accounting/services/ap/openSupplierBills', () => ({
  fetchOpenSupplierBills: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(),
}));

import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { resolveSupplierAutoAllocateStrategy } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { resolveCustomerAutoAllocateStrategy } from '@/modules/accounting/services/ar/customerAutoAllocate';
import { fetchOpenSupplierBills } from '@/modules/accounting/services/ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPPLIER = '0c000000-0000-4000-8000-000000000001';
const ACC = '0b000000-0000-4000-8000-000000000001';

interface DryRunLine {
  transaction_id: string;
  auto_apply?: string;
  applications?: { document_id: string; document_number: string; amount: number }[];
  on_account?: number;
}

function payload(res: { content: { text: string }[] }): { lines: DryRunLine[] } {
  return JSON.parse(res.content[0]!.text) as { lines: DryRunLine[] };
}

/** Money OUT against a supplier is a payment; the sign is what decides. */
function states(amounts: Record<string, number>) {
  return async (_c: string, ids: readonly string[]) => new Map(
    ids.map((id) => [id, {
      id, status: 'imported', matchedJournalLineId: null, amount: amounts[id] ?? 0,
    }]),
  );
}

function supplierLine(n: number, extra: Record<string, unknown> = {}) {
  return {
    transaction_id: TX(n), alloc_type: 'supplier', entity_id: SUPPLIER, ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(resolveSupplierAutoAllocateStrategy).mockResolvedValue('off');
  vi.mocked(resolveCustomerAutoAllocateStrategy).mockResolvedValue('off');
  vi.mocked(fetchOpenSupplierBills).mockResolvedValue([
    { invoiceId: 'b1', invoiceNumber: 'BILL-001', outstanding: 100 },
    { invoiceId: 'b2', invoiceNumber: 'BILL-002', outstanding: 200 },
  ]);
  vi.mocked(fetchOpenCustomerInvoices).mockResolvedValue([]);
});

describe('bulk_allocate_bank_transactions — dry run applications', () => {
  it('consumes the open bills line by line, in posting order', async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150, [TX(2)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [supplierLine(1), supplierLine(2)],
        dry_run: true,
        idempotency_key: 'k1',
      },
      ctx,
    ) as { content: { text: string }[] };

    const { lines } = payload(res);
    expect(lines[0]!.applications).toEqual([
      { document_id: 'b1', document_number: 'BILL-001', amount: 100 },
      { document_id: 'b2', document_number: 'BILL-002', amount: 50 },
    ]);
    // The second line sees what the first consumed — not the opening balance.
    expect(lines[1]!.applications).toEqual([
      { document_id: 'b2', document_number: 'BILL-002', amount: 150 },
    ]);
    expect(lines[1]!.on_account).toBe(0);
    // One read per DISTINCT entity, whatever the line count — and NO row lock:
    // a preview that held these rows would block every real allocation against
    // the supplier until the request ended.
    expect(fetchOpenSupplierBills).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchOpenSupplierBills).mock.calls[0]![3]).toEqual({ forUpdate: false });
  });

  it('states what the preview cannot know, in the reply', async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [supplierLine(1)], dry_run: true, idempotency_key: 'k8' }, ctx,
    ) as { content: { text: string }[] };

    const body = JSON.parse(res.content[0]!.text) as { preview_caveats?: string[] };
    expect(body.preview_caveats).toEqual([expect.stringContaining('open fiscal period')]);
  });

  it('carries no caveat when the batch previews no application at all', async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: TX(1), contra_account_id: ACC }],
        dry_run: true,
        idempotency_key: 'k9',
      },
      ctx,
    ) as { content: { text: string }[] };

    const body = JSON.parse(res.content[0]!.text) as { preview_caveats?: string[] };
    expect(body.preview_caveats).toBeUndefined();
  });

  it('reports the surplus on account when the bills run out', async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -500 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [supplierLine(1)], dry_run: true, idempotency_key: 'k2' }, ctx,
    ) as { content: { text: string }[] };

    const line = payload(res).lines[0]!;
    expect(line.applications!.map((a) => a.amount)).toEqual([100, 200]);
    expect(line.on_account).toBe(200);
  });

  it("plans nothing for a line the batch default set to 'none'", async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [supplierLine(1)], auto_apply: 'none', dry_run: true,
        idempotency_key: 'k3',
      },
      ctx,
    ) as { content: { text: string }[] };

    const line = payload(res).lines[0]!;
    expect(line.auto_apply).toBe('none');
    expect(line.applications).toEqual([]);
    expect(line.on_account).toBe(150);
  });

  it("lets a line override the batch's own default", async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150, [TX(2)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [supplierLine(1), supplierLine(2, { auto_apply: 'fifo' })],
        auto_apply: 'none',
        dry_run: true,
        idempotency_key: 'k4',
      },
      ctx,
    ) as { content: { text: string }[] };

    const { lines } = payload(res);
    expect(lines[0]!.applications).toEqual([]);
    expect(lines[1]!.applications).toEqual([
      { document_id: 'b1', document_number: 'BILL-001', amount: 100 },
      { document_id: 'b2', document_number: 'BILL-002', amount: 50 },
    ]);
  });

  it('says nothing about applications for a supplier REFUND', async () => {
    // Money IN against a supplier is a refund, not a payment: no document is
    // created and nothing is applied.
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: 150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      { allocations: [supplierLine(1)], dry_run: true, idempotency_key: 'k5' }, ctx,
    ) as { content: { text: string }[] };

    const line = payload(res).lines[0]!;
    expect(line.applications).toBeUndefined();
    expect(line.on_account).toBeUndefined();
    expect(fetchOpenSupplierBills).not.toHaveBeenCalled();
  });

  it('says nothing about applications for a plain GL line', async () => {
    vi.mocked(findBankTransactionAllocationStates).mockImplementation(
      states({ [TX(1)]: -150 }) as never,
    );

    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [{ transaction_id: TX(1), contra_account_id: ACC }],
        dry_run: true,
        idempotency_key: 'k6',
      },
      ctx,
    ) as { content: { text: string }[] };

    expect(payload(res).lines[0]!.applications).toBeUndefined();
  });

  it('refuses a batch-level auto_apply that is not a mode', async () => {
    const res = await bulkAllocateBankTransactionsTool.handler(
      {
        allocations: [supplierLine(1)], auto_apply: 'oldest', dry_run: true,
        idempotency_key: 'k7',
      },
      ctx,
    ) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('auto_apply must be one of: fifo, none');
  });
});
