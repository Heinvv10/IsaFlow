/**
 * `run_depreciation` — the monthly run over MCP.
 *
 * Three rules from CONTRACTS.md §6 are load-bearing here and each has its own
 * assertion, because getting any of them wrong is silent:
 *
 *  1. A dry run MUST set `wroteNothing`. Without it the preview is stored under
 *     the idempotency key and the real call that follows — same intent, same
 *     natural key — is served the preview forever.
 *  2. Only PRE-write validation may return `toolError`. The savepoint rolls back
 *     on a THROW, not on a returned error, so a write-then-toolError commits the
 *     partial run AND frees the key for a retry that writes again.
 *  3. The dry run returns THE JOURNALS THAT WOULD POST, not a count and not a
 *     message, and exercises every row-state guard the live path runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `previewDepreciationJournals` is left REAL — it is the thing under test. Only
// its one database dependency is stubbed, so the journal lines and amounts the
// dry run reports are computed by the same pure calculator the live path uses.
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async (key: string) => ({
    id: `acc-${key}`,
    accountCode: key === 'depreciation_expense' ? '5800' : '1230',
    accountName: key === 'depreciation_expense' ? 'Depreciation Expense' : 'Accumulated Depreciation',
    accountType: key === 'depreciation_expense' ? 'expense' : 'asset',
    accountSubtype: key,
    createdAt: 0,
  })),
  getSystemAccountId: vi.fn(async (key: string) => `acc-${key}`),
}));

vi.mock('@/modules/accounting/services/items/depreciationRunService', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/modules/accounting/services/items/depreciationRunService',
  );
  return {
    ...actual,
    loadDepreciationAssets: vi.fn(),
    planDepreciationRun: vi.fn(),
    executeDepreciationRun: vi.fn(),
  };
});

import {
  loadDepreciationAssets,
  planDepreciationRun,
  executeDepreciationRun,
  type DepreciationPlan,
} from '@/modules/accounting/services/items/depreciationRunService';
import { runDepreciationTool } from '@/lib/mcp/tools/writeDepreciation';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['write:post'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

const PLAN: DepreciationPlan = {
  periodDate: '2026-09-30',
  yyyymm: '202609',
  fiscalPeriodId: 'fp-1',
  blocker: null,
  rows: [
    {
      assetId: 'a1', assetNumber: 'AST-001', name: 'Server', cost: 85000,
      entryNumber: 'DEP-AST-001-2026-09', skipReason: null, skipDetail: null,
    },
    {
      assetId: 'a2', assetNumber: 'COMP-0001', name: 'QA Computer', cost: 15000,
      entryNumber: 'DEP-COMP-0001-2026-09',
      skipReason: 'not_in_service',
      skipDetail: 'Status is "disposed"; only available, assigned, in_maintenance are depreciated.',
    },
  ],
  postable: [
    {
      assetId: 'a1', assetNumber: 'AST-001', name: 'Server', cost: 85000,
      entryNumber: 'DEP-AST-001-2026-09', skipReason: null, skipDetail: null,
    },
  ],
  eligibleTotal: 1,
};

const ASSETS = [{
  id: 'a1', asset_number: 'AST-001', cost: 85000, residual_pct: 0,
  useful_life_years: 3, tax_life_years: 3, purchase_date: '2025-01-01',
  policy_acc_dep: 0, tax_acc_dep: 0, deferred_tax_rate: 0.27, disposal_date: null,
}];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadDepreciationAssets).mockResolvedValue(ASSETS as never);
  vi.mocked(planDepreciationRun).mockResolvedValue(PLAN);
  vi.mocked(executeDepreciationRun).mockResolvedValue({
    processed: 1, skipped: 1, glFailed: 0, total: 1,
    periodDate: '2026-09-30', yyyymm: '202609',
    results: [{ assetNumber: 'AST-001', policyDep: 2361.11, taxDep: 2361.11, entryId: 'je-1' }],
  });
});

describe('registration', () => {
  it('is registered, mirrored, metered, and requires the posting scope', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('run_depreciation');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('run_depreciation');
    // A missing flowMetering entry is `undefined` and fails the drift test.
    expect(flowOperationFor('run_depreciation', {})).not.toBeUndefined();
    expect(runDepreciationTool.write).toBe(true);
    expect(runDepreciationTool.requiresPost).toBe(true);
  });

  it('takes dry_run and idempotency_key, and dry_run is not defaulted true', () => {
    const props = runDepreciationTool.inputSchema.properties as Record<string, unknown>;
    expect(props.dry_run).toBeDefined();
    expect(props.idempotency_key).toBeDefined();
    expect((props.dry_run as { default?: unknown }).default).toBeUndefined();
  });
});

describe('dry run', () => {
  it('sets wroteNothing, so the real call is not served the preview forever', async () => {
    const res = await runDepreciationTool.handler(
      { period_date: '2026-09-30', dry_run: true, idempotency_key: 'k1' }, ctx,
    );
    expect(res.wroteNothing).toBe(true);
    expect(executeDepreciationRun).not.toHaveBeenCalled();
  });

  it('returns THE JOURNALS that would post, with their lines and their date', async () => {
    const out = json(await runDepreciationTool.handler(
      { period_date: '2026-09-30', dry_run: true, idempotency_key: 'k1' }, ctx,
    ));
    expect(out.dryRun).toBe(true);
    expect(out.journalsTotal).toBe(1);
    const j = out.journals[0];
    // The journal's DATE is the period being depreciated, not today. It used to
    // be CURRENT_DATE, so a March run posted a September journal.
    expect(j.date).toBe('2026-09-30');
    expect(j.description).toContain('AST-001');
    expect(j.fiscalPeriodId).toBe('fp-1');
    expect(j.lines).toHaveLength(2);
    expect(j.totalDebit).toBeCloseTo(j.totalCredit, 2);
    expect(j.totalDebit).toBeGreaterThan(0);
  });

  it('runs every row-state guard the live path runs, and reports the skips', async () => {
    const out = json(await runDepreciationTool.handler(
      { period_date: '2026-09-30', dry_run: true, idempotency_key: 'k1' }, ctx,
    ));
    // planDepreciationRun is the ONLY place guards live, and the dry run calls
    // exactly it — so it cannot pass where the live call would refuse.
    expect(planDepreciationRun).toHaveBeenCalledTimes(1);
    const skip = out.skipped.find((s: { id: string }) => s.id === 'a2');
    expect(skip.reason).toBe('not_in_service');
  });
});

describe('pre-write refusals', () => {
  it('refuses a closed period as a toolError, before anything is written', async () => {
    vi.mocked(planDepreciationRun).mockResolvedValue({
      ...PLAN,
      blocker: { reason: 'period_closed', detail: 'Fiscal period Sep 2026 covering 2026-09-30 is "closed". Re-open it before running depreciation.' },
    });
    const res = await runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k2' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/closed/i);
    expect(executeDepreciationRun).not.toHaveBeenCalled();
  });

  it('refuses a run with nothing postable rather than reporting a silent zero', async () => {
    vi.mocked(planDepreciationRun).mockResolvedValue({ ...PLAN, postable: [] });
    const res = await runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k3' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(executeDepreciationRun).not.toHaveBeenCalled();
  });

  it('refuses a malformed period_date before it reaches a cast', async () => {
    const res = await runDepreciationTool.handler(
      { period_date: '2026-02-31', idempotency_key: 'k4' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(planDepreciationRun).not.toHaveBeenCalled();
  });
});

describe('the live run', () => {
  it('posts and reports what it posted, including the partial-failure count', async () => {
    const out = json(await runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k5' }, ctx,
    ));
    expect(executeDepreciationRun).toHaveBeenCalledTimes(1);
    expect(out.processed).toBe(1);
    expect(out.glFailed).toBe(0);
    expect(out.period_date).toBe('2026-09-30');
  });

  it('RETHROWS a failure after the first write instead of returning a toolError', async () => {
    vi.mocked(executeDepreciationRun).mockRejectedValue(new Error('boom'));
    // A returned toolError here would RELEASE the savepoint — committing
    // whatever was posted — and free the key for a retry that posts again.
    await expect(runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k6' }, ctx,
    )).rejects.toThrow('boom');
  });

  it('takes the company from the context, never from args', async () => {
    await runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k7' }, ctx,
    );
    expect(vi.mocked(planDepreciationRun).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(executeDepreciationRun).mock.calls[0]![0]).toBe(COMPANY);
  });
});

describe('a company with no asset register', () => {
  it('says the register is empty rather than listing no reasons', async () => {
    vi.mocked(planDepreciationRun).mockResolvedValue({ ...PLAN, rows: [], postable: [], eligibleTotal: 0 });
    const res = await runDepreciationTool.handler(
      { period_date: '2026-09-30', idempotency_key: 'k8' }, ctx,
    );
    expect(res.isError).toBe(true);
    // "all 0 assets were skipped ()" is the shape this replaces — an empty
    // reason list sends a reader looking for a skip that does not exist.
    expect(res.content[0]!.text).toMatch(/no fixed assets on the register/i);
    expect(res.content[0]!.text).not.toMatch(/\(\)/);
  });
});
