/**
 * reverse_allocations — the range reversal.
 *
 * It exists because nine rule-created allocations had to be unwound one at a
 * time, and three of the nine were blocked part-way through, leaving the
 * account consistent but the job half-done with nothing saying which half.
 *
 * So the assertions that matter are the ones about NEVER producing that state:
 *  - a mid-loop failure PROPAGATES, so the registry savepoint unwinds the
 *    reversals already applied. A catch here would recreate the exact bug.
 *  - an oversize range REFUSES rather than reversing the first N silently.
 *  - dry_run writes nothing at all.
 *  - the count is taken on the true total, not on a capped page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/mcp/tools/bankPreviewApproval', () => ({
  partitionBankApprovalBound: vi.fn(async (_companyId: string, lines: Array<{ index: number; txId: string }>) => ({ postable: lines, skipped: [] })),
  bankAllocationApprovalRequired: vi.fn(async () => false),
  BANK_APPROVAL_REQUIRED_REASON: 'approval required',
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationRangeService', () => ({
  findAllocatedInRange: vi.fn(),
  countAllocatedInRange: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankStatementImportService', () => ({
  bankGlAccountBelongsToCompany: vi.fn(),
}));

import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  findAllocatedInRange,
  countAllocatedInRange,
} from '@/modules/accounting/services/bank/bankAllocationRangeService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const KEY = { idempotency_key: 'k1' };
const RANGE = { bank_account_id: BANK, from_date: '2026-03-01', to_date: '2026-03-31', ...KEY };

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:bank-tx', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}
function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

function row(id: string, ruleName: string | null = 'Reload Somerset W — Card No. 4765') {
  return {
    id,
    transactionDate: '2026-03-04',
    amount: -474.6,
    description: 'RELOAD SOMERSET',
    reference: 'REF1',
    journalEntryId: 'je-' + id,
    allocationBatchId: null, // rule-created: no batch, the whole point
    allocationRuleName: ruleName,
  };
}
const IDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(true);
  vi.mocked(countAllocatedInRange).mockResolvedValue(3);
  vi.mocked(findAllocatedInRange).mockResolvedValue(IDS.map((i) => row(i)));
});

describe('reverse_allocations', () => {
  it('reverses every row in the range and stamps the MCP posting agent', async () => {
    const r = parseOk(await reverseAllocationsTool.handler(RANGE, ctx()));
    expect(r.reversed).toBe(3);
    expect(reverseReconciledTransaction).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reverseReconciledTransaction).mock.calls[0]![3])
      .toMatchObject({ postingAgent: 'mcp:reverse_allocations:v1' });
    expect(vi.mocked(reverseReconciledTransaction).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('PROPAGATES a mid-loop failure so the savepoint unwinds what already reversed', async () => {
    // The whole reason this tool exists. A catch here would leave the range
    // half-reversed — the exact state the migration hit by hand.
    vi.mocked(reverseReconciledTransaction)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('approval required'));

    await expect(reverseAllocationsTool.handler(RANGE, ctx()))
      .rejects.toThrow('approval required');
  });

  it('REFUSES an oversize range instead of truncating it', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(501);
    const r = await reverseAllocationsTool.handler(RANGE, ctx());
    expect(errText(r)).toContain('exceeds the 500 limit');
    // Nothing fetched, nothing reversed: a partial pass would be the same
    // half-done state, only harder to notice.
    expect(findAllocatedInRange).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('dry_run reports what WOULD be reversed and writes nothing', async () => {
    const r = parseOk(await reverseAllocationsTool.handler({ ...RANGE, dry_run: true }, ctx()));
    expect(r.would_reverse).toBe(3);
    expect(r.dry_run).toBe(true);
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
    // The rule behind the allocations is what the agent has to fix next, or
    // the next import re-creates all of this.
    expect(r.rules_involved).toEqual(['Reload Somerset W — Card No. 4765']);
  });

  it('reports an empty range as success, so a retry is harmless', async () => {
    vi.mocked(countAllocatedInRange).mockResolvedValue(0);
    const r = parseOk(await reverseAllocationsTool.handler(RANGE, ctx()));
    expect(r.reversed).toBe(0);
    expect(findAllocatedInRange).not.toHaveBeenCalled();
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('refuses an inverted range rather than silently matching nothing', async () => {
    const r = await reverseAllocationsTool.handler(
      { ...RANGE, from_date: '2026-03-31', to_date: '2026-03-01' }, ctx(),
    );
    // Without this, the query matches no rows and the reply reads "0 reversed",
    // which an agent takes as "already clean".
    expect(errText(r)).toContain('is after to_date');
    expect(countAllocatedInRange).not.toHaveBeenCalled();
  });

  it('checks bank-account ownership before counting anything', async () => {
    vi.mocked(bankGlAccountBelongsToCompany).mockResolvedValue(false);
    expect(errText(await reverseAllocationsTool.handler(RANGE, ctx()))).toBe('Not found');
    expect(countAllocatedInRange).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and dates before any cast', async () => {
    expect(errText(await reverseAllocationsTool.handler(
      { ...RANGE, bank_account_id: 'abc' }, ctx(),
    ))).toBe('invalid bank_account_id');
    // Date.parse rolls 2026-02-31 to 3 March; Postgres throws 22008.
    expect(errText(await reverseAllocationsTool.handler(
      { ...RANGE, from_date: '2026-02-31' }, ctx(),
    ))).toBe('invalid from_date');
    expect(bankGlAccountBelongsToCompany).not.toHaveBeenCalled();
  });

  it('requires write:post — it posts contra journals', () => {
    expect(reverseAllocationsTool.requiresPost).toBe(true);
  });
});
