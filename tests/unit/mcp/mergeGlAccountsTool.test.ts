/**
 * `merge_gl_accounts` — the tool contract, not the accounting.
 *
 * Four things fail silently if they are wrong, and each has already gone wrong
 * somewhere in this module:
 *
 *  - a dry run that omits `wroteNothing` is stored under the idempotency key,
 *    and the real call that follows is served the preview forever;
 *  - a refusal returned AFTER a write commits the partial write and frees the
 *    key for a retry that writes again, so every refusal must be answered from
 *    the read;
 *  - a cross-tenant id must read exactly like a typo'd one, or it is an
 *    existence oracle;
 *  - a dry run that passes where the live call refuses is worse than none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getAccountById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/accountMergePreview', () => ({
  previewAccountMerge: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/glAccountLock', () => ({
  lockGlAccountsForUpdate: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/gl/accountMergeService', async () => {
  // The error class is real: the tool branches on it, and a stubbed sentinel
  // would let that branch pass by accident.
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/gl/accountMergeService')>(
    '@/modules/accounting/services/gl/accountMergeService',
  );
  return { AccountMergeError: actual.AccountMergeError, mergeAccounts: vi.fn() };
});

import { getAccountById } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { previewAccountMerge } from '@/modules/accounting/services/gl/accountMergePreview';
import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';
import { mergeAccounts, AccountMergeError } from '@/modules/accounting/services/gl/accountMergeService';
import { mergeGlAccountsTool } from '@/lib/mcp/tools/writeMergeGlAccounts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const ARGS = { source_account_id: SOURCE, target_account_id: TARGET, idempotency_key: 'k1' };

const ctx = (): McpToolContext => ({
  userId: '44444444-4444-4444-8444-444444444444',
  companyId: COMPANY,
  scopes: ['write:accounts', 'write:post'],
  tokenJti: 'jti',
  oauthAppId: null,
} as McpToolContext);

function payload(r: McpToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function preview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { accountId: SOURCE, accountCode: 'SYS-8', postedDebit: 0, postedCredit: 100 },
    target: { accountId: TARGET, accountCode: '2110', postedDebit: 0, postedCredit: 40 },
    sourceAfter: {}, targetAfter: {},
    linesToRepoint: 3, entries: [], entriesTotal: 3, truncatedEntries: false,
    skips: [], skipsTotal: 0, truncatedSkips: false, blocked: false,
    trialBalance: { unchanged: true }, childAccounts: [],
    systemAccountImpact: {}, postedThrough: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccountById).mockResolvedValue({ id: SOURCE } as never);
  vi.mocked(previewAccountMerge).mockResolvedValue(preview() as never);
  vi.mocked(lockGlAccountsForUpdate).mockResolvedValue([] as never);
});

describe('merge_gl_accounts', () => {
  it('is a posting-scoped write and takes both mutation arguments', () => {
    expect(mergeGlAccountsTool.write).toBe(true);
    expect(mergeGlAccountsTool.requiresPost).toBe(true);
    const props = mergeGlAccountsTool.inputSchema.properties as Record<string, unknown>;
    expect(props.dry_run).toBeDefined();
    expect(props.idempotency_key).toBeDefined();
    expect(mergeGlAccountsTool.inputSchema.required).toContain('idempotency_key');
  });

  it('a dry run writes nothing and frees the idempotency key', async () => {
    const r = await mergeGlAccountsTool.handler({ ...ARGS, dry_run: true }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBe(true);
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(payload(r).dryRun).toBe(true);
  });

  it('a live call does NOT claim it wrote nothing', async () => {
    vi.mocked(mergeAccounts).mockResolvedValue({ linesRepointed: 3 } as never);
    const r = await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(r.wroteNothing).toBeFalsy();
    expect(mergeAccounts).toHaveBeenCalledWith(
      COMPANY, SOURCE, TARGET, expect.any(String),
      expect.objectContaining({ actorType: 'agent' }),
    );
  });

  it('the dry run runs the SAME row-state guards, so it refuses where the live call would', async () => {
    vi.mocked(previewAccountMerge).mockResolvedValue(preview({
      blocked: true, skipsTotal: 2,
      skips: [{ reason: 'fiscal_period_closed', debit: 50, credit: 0 }],
    }) as never);

    const dry = await mergeGlAccountsTool.handler({ ...ARGS, dry_run: true }, ctx());
    expect(payload(dry).blocked).toBe(true);

    const live = await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(live.isError).toBe(true);
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('answers a guard refusal from the READ, before anything can have written', async () => {
    vi.mocked(previewAccountMerge).mockRejectedValue(
      new AccountMergeError('Cannot merge a system account', 'source_is_system_account'),
    );
    const r = await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('system account');
    expect(mergeAccounts).not.toHaveBeenCalled();
  });

  it('rethrows anything the merge itself raises, so the savepoint unwinds', async () => {
    vi.mocked(mergeAccounts).mockRejectedValue(new Error('boom'));
    await expect(mergeGlAccountsTool.handler(ARGS, ctx())).rejects.toThrow('boom');
  });

  it('locks both accounts on the live path, and NOT on a dry run', async () => {
    vi.mocked(mergeAccounts).mockResolvedValue({ linesRepointed: 3 } as never);

    await mergeGlAccountsTool.handler({ ...ARGS, dry_run: true }, ctx());
    // A preview writes nothing and must not hold rows against everyone else for
    // the rest of the request.
    expect(lockGlAccountsForUpdate).not.toHaveBeenCalled();

    await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(lockGlAccountsForUpdate).toHaveBeenCalledWith(COMPANY, [SOURCE, TARGET]);
    // Taken BEFORE the preview reads the state the write then acts on.
    const lockOrder = vi.mocked(lockGlAccountsForUpdate).mock.invocationCallOrder[0]!;
    const previewOrder = vi.mocked(previewAccountMerge).mock.invocationCallOrder.at(-1)!;
    expect(lockOrder).toBeLessThan(previewOrder);
  });

  it('turns a lock timeout into a refusal that says retry, not a generic failure', async () => {
    const timeout = Object.assign(new Error('GL account X is being changed by another request — retry in a moment.'),
      { code: 'GL_ACCOUNT_LOCK_TIMEOUT' });
    vi.mocked(lockGlAccountsForUpdate).mockRejectedValue(timeout);

    const r = await mergeGlAccountsTool.handler(ARGS, ctx());
    // Write-free by construction: the lock is the first thing the live path
    // does. Left to propagate, the registry would render it GENERIC_FAILURE and
    // the agent would never learn it can simply retry.
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('retry');
    expect(mergeAccounts).not.toHaveBeenCalled();
    expect(previewAccountMerge).not.toHaveBeenCalled();
  });

  it('rethrows a lock failure that is NOT a timeout', async () => {
    vi.mocked(lockGlAccountsForUpdate).mockRejectedValue(new Error('connection reset'));
    await expect(mergeGlAccountsTool.handler(ARGS, ctx())).rejects.toThrow('connection reset');
  });

  it('refuses an id from another company with the generic miss text', async () => {
    vi.mocked(getAccountById).mockResolvedValue(null as never);
    const r = await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
    expect(previewAccountMerge).not.toHaveBeenCalled();
  });

  it('refuses a malformed id before it can reach a cast', async () => {
    const r = await mergeGlAccountsTool.handler({ ...ARGS, source_account_id: 'nope' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('invalid source_account_id');
    expect(getAccountById).not.toHaveBeenCalled();
  });

  it('tells a reader what breaks if the merge is wrong, on BOTH the preview and the result', async () => {
    vi.mocked(mergeAccounts).mockResolvedValue({ linesRepointed: 3 } as never);
    const dry = await mergeGlAccountsTool.handler({ ...ARGS, dry_run: true }, ctx());
    const live = await mergeGlAccountsTool.handler(ARGS, ctx());
    // The live reply is the one an agent reads after the fact, and it is the one
    // that would quietly lose the warning. Asserting the constant's LENGTH would
    // not catch that; asserting it is on both replies does.
    expect(payload(dry).ifThisIsWrong).toBe(payload(live).ifThisIsWrong);
    expect(String(payload(live).ifThisIsWrong)).toContain('trial balance');
  });

  it('refuses when only the TARGET belongs to another company', async () => {
    // Mocking both lookups to null lets a handler that checks only the source
    // pass this test. The target has to be the one that is missing.
    vi.mocked(getAccountById).mockImplementation(async (_c: string, id: string) =>
      (id === SOURCE ? ({ id: SOURCE } as never) : null));
    const r = await mergeGlAccountsTool.handler(ARGS, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
    expect(previewAccountMerge).not.toHaveBeenCalled();
  });
});
