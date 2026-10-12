/**
 * Dimensions Phase 1 — the MCP surface: per-line cc1/cc2/bu on the capture
 * tools, and the new tools (split, tag, masters, defaults).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), getPoolForTests: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(), reverseReconciledTransaction: vi.fn(), splitAllocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(async () => true), suppliersBelongToCompany: vi.fn(async () => true),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(), findBankTransactionsByReferences: vi.fn(async () => new Map()),
  getBankTransactionStatus: vi.fn(async () => 'imported'),
  findBankTransactionAllocationStates: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionRefResolver', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/dimensions/dimensionRefResolver')>()),
  resolveDimensionRefs: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionDerivation', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/dimensions/dimensionDerivation')>()),
  deriveLineDimensions: vi.fn(async (_c: string, lines: unknown[]) => lines),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/dimensions/dimensionPolicy')>()),
  cosProjectWarnings: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/bank/bankSplitDimensions', () => ({ planSplitDimensionsForTransaction: vi.fn() }));
vi.mock('@/lib/mcp/tools/allocationVatGuard', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/allocationVatGuard')>()),
  resolveLineVatCode: vi.fn(async (_c: string, _t: string, line: { vatCode?: string }) => ({ effectiveVatCode: line.vatCode })),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionTagPlan', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/dimensions/dimensionTagPlan')>()),
  planDimensionTags: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionBankSync', () => ({
  previewBankSync: vi.fn(async () => ({ count: 0, sample: [] })), applyBankSyncBatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionTagApply', () => ({
  applyDimensionTags: vi.fn(), findTagBatchByKey: vi.fn(async () => null),
  planTagBatchReversal: vi.fn(), applyTagBatchReversal: vi.fn(),
}));

import { allocateTransaction, splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { resolveDimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionRefResolver';
import { cosProjectWarnings } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { planSplitDimensionsForTransaction } from '@/modules/accounting/services/bank/bankSplitDimensions';
import { resolveLineVatCode } from '@/lib/mcp/tools/allocationVatGuard';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { applyDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { allocateBankTransactionTool } from '@/lib/mcp/tools/writeBankAllocate';
import { splitAllocateBankTransactionTool } from '@/lib/mcp/tools/writeBankSplit';
import { syncBankDimensionsTool, tagJournalLinesTool } from '@/lib/mcp/tools/writeDimensionTags';
import { applyBankSyncBatch, previewBankSync } from '@/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { setGlAccountReportingAttributesTool } from '@/lib/mcp/tools/dimensionDefaultsTools';
import { DimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const ctx = { companyId: 'company-1', userId: 'user-1', tokenJti: 'jti', oauthAppId: null, scopes: [] } as never;
const TX = '045ef594-d81d-4f21-84d6-1151ed71260d';
const FUEL = 'cf9df9b9-9fc0-424b-8137-47e9ba144c73';
const TOLLS = 'ddd887ce-a246-46cb-898c-2bd2f4ddecfe';
const KEY = { idempotency_key: 'k' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('allocate_bank_transaction — cc1 / cc2 / bu', () => {
  it('resolves the codes and passes the ids to the service for the cost line', async () => {
    vi.mocked(resolveDimensionRefs).mockResolvedValueOnce([{ cc2Id: 'id-lawley', buId: 'id-build' }]);
    vi.mocked(allocateTransaction).mockResolvedValueOnce({ journalEntryId: 'je', bankTransaction: { id: TX } } as never);
    vi.mocked(cosProjectWarnings).mockResolvedValueOnce([]);
    const r = await allocateBankTransactionTool.handler({
      transaction_id: TX, contra_account_id: FUEL, cc2: 'LAWLEY', bu: 'BUILD', ...KEY,
    }, ctx);
    expect(r.isError).toBeFalsy();
    const call = vi.mocked(allocateTransaction).mock.calls[0]!;
    expect([call[8], call[9], call[10]]).toEqual([undefined, 'id-lawley', 'id-build']);
  });

  it('refuses dimensions on a supplier payment before any lookup', async () => {
    const r = await allocateBankTransactionTool.handler({
      transaction_id: TX, alloc_type: 'supplier', entity_id: FUEL, cc2: 'LAWLEY', ...KEY,
    }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/carries no cc1\/cc2\/bu/);
    expect(resolveDimensionRefs).not.toHaveBeenCalled();
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('answers an unknown code as a tool error naming the line, before posting', async () => {
    vi.mocked(resolveDimensionRefs).mockRejectedValueOnce(new DimensionRefusal('allocation.cc2 "NOPE" does not name an active CC2'));
    const r = await allocateBankTransactionTool.handler({ transaction_id: TX, contra_account_id: FUEL, cc2: 'NOPE', ...KEY }, ctx);
    expect(text(r)).toMatch(/allocation\.cc2 "NOPE"/);
    expect(allocateTransaction).not.toHaveBeenCalled();
  });

  it('reports a COS line with no project as dimension_warnings', async () => {
    vi.mocked(allocateTransaction).mockResolvedValueOnce({ journalEntryId: 'je', bankTransaction: { id: TX } } as never);
    vi.mocked(cosProjectWarnings).mockResolvedValueOnce(['allocation: cost-of-sales line with no project (CC2)']);
    const r = await allocateBankTransactionTool.handler({ transaction_id: TX, contra_account_id: FUEL, ...KEY }, ctx);
    expect(JSON.parse(text(r)).dimension_warnings).toHaveLength(1);
  });
});

describe('split_allocate_bank_transaction', () => {
  const lines = [
    { contra_account_id: FUEL, amount: 69, vat_code: 'standard', cc2: 'LAWLEY' },
    { contra_account_id: TOLLS, amount: 46, bu: 'MAINT' },
  ];
  beforeEach(() => {
    vi.mocked(findBankTransactionAllocationStates).mockResolvedValue(new Map([[TX, {
      id: TX, status: 'imported', matchedJournalLineId: null, amount: -115, feedState: 'posted',
    }]]) as never);
    vi.mocked(resolveDimensionRefs).mockResolvedValue([{ cc2Id: 'id-lawley' }, { buId: 'id-maint' }]);
    vi.mocked(planSplitDimensionsForTransaction).mockResolvedValue({
      dims: [{ cc1Id: 'id-ft', cc2Id: 'id-lawley' }, { buId: 'id-maint' }], warnings: [],
    });
  });

  it('refuses lines that do not sum to the transaction, before posting', async () => {
    const r = await splitAllocateBankTransactionTool.handler({
      transaction_id: TX, lines: [{ ...lines[0], amount: 60 }, lines[1]], ...KEY,
    }, ctx);
    expect(text(r)).toMatch(/does not equal the transaction amount R115\.00/);
    expect(splitAllocateTransaction).not.toHaveBeenCalled();
  });

  it('REFUSES (does not coerce) a VAT code the guard would change', async () => {
    vi.mocked(resolveLineVatCode).mockResolvedValueOnce({ effectiveVatCode: 'none', vatCoerced: { from: 'standard', to: 'none', reason: 'no supply' } } as never);
    const r = await splitAllocateBankTransactionTool.handler({ transaction_id: TX, lines, ...KEY }, ctx);
    expect(text(r)).toMatch(/lines\[0\]\.vat_code standard is not claimable/);
    expect(splitAllocateTransaction).not.toHaveBeenCalled();
  });

  it('dry_run previews the per-line dimensions and writes nothing', async () => {
    const r = await splitAllocateBankTransactionTool.handler({ transaction_id: TX, lines, dry_run: true, ...KEY }, ctx);
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r)).lines[0]).toMatchObject({ cc1_id: 'id-ft', cc2_id: 'id-lawley' });
    expect(splitAllocateTransaction).not.toHaveBeenCalled();
  });

  it('posts through the shared service with each line\'s dimensions and the agent stamp', async () => {
    vi.mocked(splitAllocateTransaction).mockResolvedValueOnce({ journalEntryId: 'je-9', bankTransaction: { id: TX } } as never);
    const r = await splitAllocateBankTransactionTool.handler({ transaction_id: TX, lines, ...KEY }, ctx);
    expect(JSON.parse(text(r)).journal_entry_id).toBe('je-9');
    const [, , splitLines, , opts] = vi.mocked(splitAllocateTransaction).mock.calls[0]!;
    expect(splitLines).toEqual([
      expect.objectContaining({ contraAccountId: FUEL, amount: 69, vatCode: 'standard', cc2Id: 'id-lawley' }),
      expect.objectContaining({ contraAccountId: TOLLS, amount: 46, buId: 'id-maint' }),
    ]);
    expect(opts).toMatchObject({ postingAgent: 'mcp:split_allocate_bank_transaction:v1' });
  });
});

describe('tag_journal_lines', () => {
  const LINE = '22222222-2222-4222-8222-222222222222';

  it('REFUSES any field that is not a dimension — on a line and at the top level', async () => {
    const r1 = await tagJournalLinesTool.handler({ lines: [{ journal_line_id: LINE, cc2: 'X', debit: 100 }], ...KEY }, ctx);
    expect(text(r1)).toMatch(/carries debit: tag_journal_lines changes dimensions only/);
    const r2 = await tagJournalLinesTool.handler({ lines: [{ journal_line_id: LINE, cc2: 'X' }], gl_account_id: FUEL, ...KEY }, ctx);
    expect(text(r2)).toMatch(/Unknown argument\(s\): gl_account_id/);
    expect(planDimensionTags).not.toHaveBeenCalled();
  });

  it('dry_run plans and writes nothing; the live call applies under the idempotency key', async () => {
    const plan = { lines: [{ journalLineId: LINE, entryNumber: 'JE-1', accountCode: '5100', old: {}, next: { cc2Id: 'p' }, unallocatedReason: null, periodClosed: false }], unchanged: [], isRestatement: false, warnings: [] };
    vi.mocked(planDimensionTags).mockResolvedValue(plan);
    const dry = await tagJournalLinesTool.handler({ lines: [{ journal_line_id: LINE, cc2: 'P' }], dry_run: true, ...KEY }, ctx);
    expect(dry.wroteNothing).toBe(true);
    expect(applyDimensionTags).not.toHaveBeenCalled();
    vi.mocked(applyDimensionTags).mockResolvedValueOnce({ batchId: 'b-1', lineCount: 1, isRestatement: false });
    const live = await tagJournalLinesTool.handler({ lines: [{ journal_line_id: LINE, cc2: 'P' }], ...KEY }, ctx);
    expect(JSON.parse(text(live)).batch_id).toBe('b-1');
    expect(vi.mocked(applyDimensionTags).mock.calls[0]![2]).toMatchObject({ idempotencyKey: 'k', userId: 'user-1' });
  });
});

describe('sync_bank_dimensions', () => {
  it('refuses a non-dimension argument and a bad date before reading anything', async () => {
    const r1 = await syncBankDimensionsTool.handler({ amount: 1, ...KEY }, ctx);
    expect(text(r1)).toMatch(/Unknown argument\(s\): amount/);
    const r2 = await syncBankDimensionsTool.handler({ date_from: '2026-13-01', date_to: '2026-10-31', ...KEY }, ctx);
    expect(text(r2)).toMatch(/date_from and date_to/);
    const r3 = await syncBankDimensionsTool.handler({ date_from: '2026-10-09', date_to: '2026-10-01', ...KEY }, ctx);
    expect(text(r3)).toMatch(/must not be after/);
    expect(previewBankSync).not.toHaveBeenCalled();
  });

  it('dry_run previews and writes nothing; the live call applies one reversible batch', async () => {
    vi.mocked(previewBankSync).mockResolvedValueOnce({ count: 1, sample: [{
      bankTransactionId: TX, transactionDate: '2026-10-02', amount: -5500, description: 'CASUAL',
      old: { cc1Id: null, cc2Id: null, buId: null }, next: { cc1Id: 'u1', cc2Id: 'u2', buId: null },
    }] });
    const dry = await syncBankDimensionsTool.handler({ date_from: '2026-10-01', date_to: '2026-10-31', dry_run: true, ...KEY }, ctx);
    expect(dry.wroteNothing).toBe(true);
    expect(JSON.parse(text(dry)).would_sync).toBe(1);
    expect(applyBankSyncBatch).not.toHaveBeenCalled();
    vi.mocked(applyBankSyncBatch).mockResolvedValueOnce({ batchId: 'b-2', bankRowCount: 1 });
    const live = await syncBankDimensionsTool.handler({ date_from: '2026-10-01', date_to: '2026-10-31', ...KEY }, ctx);
    expect(JSON.parse(text(live))).toEqual({ batch_id: 'b-2', bank_rows_synced: 1 });
    expect(vi.mocked(applyBankSyncBatch).mock.calls[0]![1]).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  });
});

describe('set_gl_account_reporting_attributes', () => {
  it('refuses an unknown field rather than ignoring it', async () => {
    const r = await setGlAccountReportingAttributesTool.handler({
      items: [{ account: '5100', statement_line: 'COS', account_type: 'expense' }], ...KEY,
    }, ctx);
    expect(text(r)).toMatch(/unknown field\(s\): account_type/);
  });
});
