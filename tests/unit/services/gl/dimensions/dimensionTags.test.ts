/**
 * Dimensions Phase 1 — tag_journal_lines: dimension-only back-tagging of
 * POSTED lines, audited per line with old values, reversible.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
// The bank-row SQL (lock, mirror, guarded write) is proven against a real database in
// tests/integration/bank-dimension-sync*.int.test.ts; here only what dimensionTagApply asks of it.
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionBankSync', () => ({
  applyBankSync: vi.fn(async () => 0), countBankRowDrift: vi.fn(async () => 0),
  countBankRows: vi.fn(async () => 0), lockBatchBankRows: vi.fn(async () => undefined), restoreBankRows: vi.fn(async () => undefined),
}));

import { sql } from '@/lib/neon';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import {
  applyDimensionTags, applyTagBatchReversal, assertKeyIsFor, findTagBatchByKey, planTagBatchReversal,
} from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import {
  applyBankSync, countBankRowDrift, countBankRows, lockBatchBankRows, restoreBankRows,
} from '@/modules/accounting/services/gl/dimensions/dimensionBankSync';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
const HEROTEL = 'aaaaaaaa-0000-4000-8000-000000000002';
const LAWLEY = 'cccccccc-0000-4000-8000-000000000001';
const BATCH = '99999999-9999-4999-8999-999999999999';

const lineRow = (over: Record<string, unknown> = {}) => ({
  id: LINE, cc1: HEROTEL, cc2: null, bu: null, gl_account_id: 'acct-cos', account_code: '5100',
  account_subtype: 'cost_of_sales', status: 'posted', source: 'auto_supplier_invoice', entry_number: 'JE-2025-1',
  period_status: 'closed', ...over,
});
const sqlText = (i: number): string => (mockSql.mock.calls[i]![0] as string[]).join('?');

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(applyBankSync).mockReset().mockResolvedValue(0);
  vi.mocked(countBankRowDrift).mockReset().mockResolvedValue(0);
  vi.mocked(countBankRows).mockReset().mockResolvedValue(0);
  vi.mocked(lockBatchBankRows).mockReset().mockResolvedValue(undefined);
  vi.mocked(restoreBankRows).mockReset().mockResolvedValue(undefined);
});

describe('planDimensionTags — refusals (all from reads)', () => {
  it.each([
    ['a control-account line', { account_subtype: 'bank' }, /control-account line/],
    ['a draft journal', { status: 'draft' }, /only posted lines/],
    ['a settlement journal', { source: 'auto_supplier_payment', account_subtype: 'operating_expense' }, /settlement/],
  ])('refuses %s', async (_l, over, msg) => {
    mockSql.mockResolvedValueOnce([lineRow(over)]);
    await expect(planDimensionTags(COMPANY, [{ journalLineId: LINE, bu: 'MAINT' }])).rejects.toThrow(msg);
  });

  it('refuses a line not in this company, without saying whose it is', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(planDimensionTags(COMPANY, [{ journalLineId: LINE, bu: 'X' }]))
      .rejects.toThrow('1 journal_line_id(s) not found in this company');
  });

  it('refuses a duplicate line and more than 500 lines before any query', async () => {
    await expect(planDimensionTags(COMPANY, [{ journalLineId: LINE }, { journalLineId: LINE }])).rejects.toThrow(/listed twice/);
    const many = Array.from({ length: 501 }, () => ({ journalLineId: LINE }));
    await expect(planDimensionTags(COMPANY, many)).rejects.toThrow(/1 to 500/);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('planDimensionTags — the plan', () => {
  it('a new project re-derives the FNO, records the OLD values, and flags a closed period as a restatement', async () => {
    mockSql
      .mockResolvedValueOnce([lineRow()]) // the lines, FOR UPDATE
      .mockResolvedValueOnce([{ id: LAWLEY, code: 'LAWLEY', cc_type: 'cc2', is_active: true }]) // resolve 'LAWLEY'
      .mockResolvedValueOnce([ // the parent chain
        { id: LAWLEY, code: 'LAWLEY', parent_id: FT, cc_type: 'cc2' },
        { id: FT, code: 'FIBERTIME', parent_id: null, cc_type: 'cc1' },
      ]);
    const plan = await planDimensionTags(COMPANY, [{ journalLineId: LINE, cc2: 'LAWLEY', unallocatedReason: undefined }]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      old: { cc1Id: HEROTEL, cc2Id: undefined, buId: undefined },
      next: { cc1Id: FT, cc2Id: LAWLEY },
      periodClosed: true,
    });
    expect(plan.isRestatement).toBe(true);
    expect(sqlText(0)).toMatch(/FOR UPDATE OF jl/);
    expect(sqlText(0)).toMatch(/jl\.company_id = \?::UUID/);
  });

  it('a line already carrying the requested values is reported unchanged, not written', async () => {
    mockSql
      .mockResolvedValueOnce([lineRow({ cc1: null, bu: 'dddddddd-0000-4000-8000-000000000001', period_status: 'open' })])
      .mockResolvedValueOnce([{ id: 'dddddddd-0000-4000-8000-000000000001', code: 'MAINT', is_active: true }])
      .mockResolvedValueOnce([{ enforced: false, cos_ids: ['acct-cos'] }]);
    const plan = await planDimensionTags(COMPANY, [{ journalLineId: LINE, bu: 'MAINT' }]);
    expect(plan.lines).toEqual([]);
    expect(plan.unchanged).toEqual([LINE]);
    expect(plan.warnings[0]).toMatch(/no project/);
  });
});

describe('applyDimensionTags — writes dimensions and nothing else', () => {
  it('writes the batch, the per-line audit (old AND new), then UPDATEs only cc1/cc2/bu', async () => {
    mockSql.mockResolvedValueOnce([{ id: BATCH }]).mockResolvedValue([]);
    const out = await applyDimensionTags(COMPANY, {
      lines: [{
        journalLineId: LINE, entryNumber: 'JE-1', accountCode: '5100', old: { cc1Id: HEROTEL },
        next: { cc1Id: FT, cc2Id: LAWLEY }, unallocatedReason: null, periodClosed: true,
      }],
      unchanged: [], isRestatement: true, warnings: [],
    }, { idempotencyKey: 'k1', reason: 'FY26 back-tag', userId: 'user-1' });
    expect(out).toEqual({ batchId: BATCH, lineCount: 1, isRestatement: true, bankRowCount: 0 });
    expect(sqlText(0)).toMatch(/INSERT INTO dimension_tag_batches/);
    expect(sqlText(1)).toMatch(/INSERT INTO dimension_tag_batch_lines[\s\S]*old_cc1_id[\s\S]*new_cc1_id/);
    const update = sqlText(2);
    expect(update).toMatch(/UPDATE gl_journal_lines jl\s+SET cc1_id = bl\.new_cc1_id, cc2_id = bl\.new_cc2_id, bu_id = bl\.new_bu_id\s+FROM/);
    expect(update).not.toMatch(/debit|credit|gl_account_id|entry_date|description|vat_type/);
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('then mirrors the batch\'s journals onto their bank rows (scope: this batch) and reports how many changed', async () => {
    mockSql.mockResolvedValueOnce([{ id: BATCH }]).mockResolvedValue([]);
    vi.mocked(applyBankSync).mockResolvedValueOnce(3);
    const out = await applyDimensionTags(COMPANY, {
      lines: [{ journalLineId: LINE, entryNumber: 'JE-1', accountCode: '5100', old: {}, next: { cc1Id: FT, cc2Id: LAWLEY },
        unallocatedReason: null, periodClosed: false }],
      unchanged: [], isRestatement: false, warnings: [],
    }, { idempotencyKey: 'k2', userId: 'user-1' });
    expect(out.bankRowCount).toBe(3);
    expect(applyBankSync).toHaveBeenCalledWith(COMPANY, BATCH, { tagBatchId: BATCH });
    // After the journal lines are written: the sync reads the lines as this batch left them.
    expect(vi.mocked(applyBankSync).mock.invocationCallOrder[0]!).toBeGreaterThan(mockSql.mock.invocationCallOrder[2]!);
  });
});

describe('an idempotency key names one batch of one kind and window', () => {
  const tagBatch = { batchId: BATCH, lineCount: 2, isRestatement: false };
  const syncBatch = { ...tagBatch, lineCount: 0, sync: { dateFrom: '2026-10-01', dateTo: '2026-10-31' } };

  it('reads the window off a sync batch and none off a tag batch', async () => {
    mockSql.mockResolvedValueOnce([{ id: BATCH, line_count: 0, is_restatement: false, sync_from: '2026-10-01', sync_to: '2026-10-31' }]);
    expect(await findTagBatchByKey(COMPANY, 'k')).toEqual(syncBatch);
    mockSql.mockResolvedValueOnce([{ id: BATCH, line_count: 2, is_restatement: false, sync_from: null, sync_to: null }]);
    expect(await findTagBatchByKey(COMPANY, 'k')).toEqual(tagBatch);
    mockSql.mockResolvedValueOnce([]);
    expect(await findTagBatchByKey(COMPANY, 'k')).toBeNull();
  });

  it('a tool replays its own kind and refuses the other, with the remedy', () => {
    expect(() => assertKeyIsFor(tagBatch, 'k', 'tag_journal_lines')).not.toThrow();
    expect(() => assertKeyIsFor(syncBatch, 'k', { dateFrom: '2026-10-01', dateTo: '2026-10-31' })).not.toThrow();
    expect(() => assertKeyIsFor(syncBatch, 'k', 'tag_journal_lines')).toThrow(/idempotency_key k already names a sync_bank_dimensions batch\. Use a fresh/);
    expect(() => assertKeyIsFor(tagBatch, 'k', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }))
      .toThrow(/idempotency_key k already names a tag_journal_lines batch\. Use a fresh/);
  });

  it('a sync of another window under the key is refused, either end', () => {
    expect(() => assertKeyIsFor(syncBatch, 'k', { dateFrom: '2026-10-02', dateTo: '2026-10-31' }))
      .toThrow(/for 2026-10-01 to 2026-10-31, not 2026-10-02 to 2026-10-31/);
    expect(() => assertKeyIsFor(syncBatch, 'k', { dateFrom: '2026-10-01', dateTo: '2026-11-30' })).toThrow(/not 2026-10-01 to 2026-11-30/);
  });
});

describe('reverse_dimension_tag_batch', () => {
  it('refuses an already reversed batch and one whose lines were re-tagged since', async () => {
    mockSql.mockResolvedValueOnce([{ id: BATCH, reversed_at: new Date(), line_count: 1, is_restatement: false }]);
    await expect(planTagBatchReversal(COMPANY, BATCH)).rejects.toThrow(/already reversed/);
    mockSql
      .mockResolvedValueOnce([{ id: BATCH, reversed_at: null, line_count: 2, is_restatement: false }])
      .mockResolvedValueOnce([{ n: 1 }]);
    await expect(planTagBatchReversal(COMPANY, BATCH)).rejects.toThrow(/re-tagged after it/);
  });

  it('refuses when a bank row of the batch was re-tagged since', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: BATCH, reversed_at: null, line_count: 1, is_restatement: false }])
      .mockResolvedValueOnce([{ n: 0 }]);
    vi.mocked(countBankRowDrift).mockResolvedValueOnce(2);
    await expect(planTagBatchReversal(COMPANY, BATCH)).rejects.toThrow(/2 bank transaction\(s\) of batch .* re-tagged after it/);
  });

  it('locks the batch\'s bank rows BEFORE it checks them for drift', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: BATCH, reversed_at: null, line_count: 1, is_restatement: false }])
      .mockResolvedValueOnce([{ n: 0 }]);
    await planTagBatchReversal(COMPANY, BATCH);
    expect(lockBatchBankRows).toHaveBeenCalledWith(COMPANY, BATCH);
    expect(vi.mocked(lockBatchBankRows).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(countBankRowDrift).mock.invocationCallOrder[0]!);
  });

  it('plans the line count AND the bank-row count (a sync batch has no lines)', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: BATCH, reversed_at: null, line_count: 0, is_restatement: false }])
      .mockResolvedValueOnce([{ n: 0 }]);
    vi.mocked(countBankRows).mockResolvedValueOnce(7);
    expect(await planTagBatchReversal(COMPANY, BATCH)).toEqual({ batchId: BATCH, lineCount: 0, bankRowCount: 7, isRestatement: false });
  });

  it('restores the OLD values on the lines AND the bank rows, then marks the batch reversed', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: BATCH, reversed_at: null, line_count: 1, is_restatement: true }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValue([]);
    const plan = await planTagBatchReversal(COMPANY, BATCH);
    await applyTagBatchReversal(COMPANY, plan, { userId: 'user-1' });
    expect(sqlText(2)).toMatch(/SET cc1_id = bl\.old_cc1_id, cc2_id = bl\.old_cc2_id, bu_id = bl\.old_bu_id/);
    expect(restoreBankRows).toHaveBeenCalledWith(COMPANY, BATCH);
    expect(vi.mocked(restoreBankRows).mock.invocationCallOrder[0]!).toBeGreaterThan(mockSql.mock.invocationCallOrder[2]!);
    expect(sqlText(3)).toMatch(/UPDATE dimension_tag_batches\s+SET reversed_at = NOW\(\)/);
    expect(vi.mocked(restoreBankRows).mock.invocationCallOrder[0]!).toBeLessThan(mockSql.mock.invocationCallOrder[3]!);
  });
});
