/**
 * budget_remaining, budget_tracking and submit_budget_for_review (MCP budget tools PR 3), services mocked, the
 * registry real where a fence is the subject (and the REAL handler registered: a fence that let the call through
 * would run it, so the assertions are on the services it never reached):
 *  - budget_remaining: budget writers only (the app's preview is withWriteAccess), the app's bounds, lines resolved
 *    as the app's route takes them (any account of the company, any dimensions: they map onto the account's level in
 *    the service), an unknown reference refused in place, a TrackingError answered with its message, the mcp- bucket;
 *  - budget_tracking: overspend alerts only; owner / admin, fenced by the registry (the alerts route's roles); paged;
 *  - submit_budget_for_review: the holder's own open / returned slice by version, or a slice id; several or none
 *    refused with the list; dry run rolled back; refusals reach the agent; a viewer fenced; the mcp- bucket;
 *  - replay and the freed key through the registry with the real handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
const audit = vi.hoisted(() => ({ recordToolCall: vi.fn(async () => undefined), acquireIdempotencyLock: vi.fn(async () => undefined), findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })) }));
vi.mock('@/lib/mcp/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp/audit')>()), ...audit }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({ ...(await orig<object>()), loadChartRefs: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/remainingBudget', async (orig) => ({ ...(await orig<object>()), remainingFor: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetAlertList', async (orig) => ({ ...(await orig<object>()), listBudgetAlerts: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/sliceReviewRead', () => ({ readSlice: vi.fn(), listSlices: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/sliceReviewState', async (orig) => ({ ...(await orig<object>()), transitionSlice: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { checkRateLimit } from '@/lib/rateLimit';
import { WITH_ROLE_ADMITS } from '@/lib/auth/withRole';
import { BUDGET_CONTROL_ADMIN_ROLES } from '@/lib/budgetControlsResponse';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadChartRefs } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { listBudgetAlerts } from '@/modules/accounting/services/budgets/budgetAlertList';
import { listSlices, readSlice } from '@/modules/accounting/services/budgets/sliceReviewRead';
import { transitionSlice } from '@/modules/accounting/services/budgets/sliceReviewState';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpTool } from '@/lib/mcp/types';
import { budgetRemainingTool, budgetTrackingTool } from '@/lib/mcp/tools/budgetControlTools';
import { submitBudgetForReviewTool } from '@/lib/mcp/tools/budgetSliceTools';
import { CC1, RENT, VERSION, ctx, json, text, version } from './budgetToolsFixture';

const SLICE = '40000000-0000-4000-8000-000000000001';
const BANK = '20000000-0000-4000-8000-000000000009';
const BU = '30000000-0000-4000-8000-000000000003';
const slice = (over: Record<string, unknown> = {}) => ({
  id: SLICE, versionId: VERSION, versionName: 'Budget', fiscalYear: 2027, versionStatus: 'draft', cc1Id: CC1, cc2Id: null, buId: null,
  label: 'CC1 C1 Centre', status: 'open', dueDate: null, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null, decisionNote: null,
  holders: [{ id: 'h', userId: 'u-1', name: 'Me', glAccountIds: null }], ...over,
});
const registryWith = (tool: McpTool) => { const r = new McpRegistry(); r.register(tool); return r; };
const result = (over: Record<string, unknown>) => ({
  key: { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03' }, versionId: VERSION, grain: 'company',
  slice: { cc1Id: null, cc2Id: null, buId: null }, unassigned: false, offSlice: false, budget: null, actual: 0, committed: 0, remaining: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadChartRefs).mockResolvedValue({
    accounts: [{ id: RENT, code: '6000' }, { id: BANK, code: '1000' }],
    members: [{ id: CC1, code: 'C1', kind: 'cc1' }, { id: BU, code: 'B', kind: 'bu' }],
  });
});

describe('budget_remaining', () => {
  it('a viewer is refused before any read (the app\'s preview is for budget writers)', async () => {
    expect(text(await budgetRemainingTool.handler({ lines: [{ account: '6000', month: '2026-03' }] }, ctx('viewer', ['read:reports'])))).toMatch(/owners, admins and managers/);
    expect(remainingFor).not.toHaveBeenCalled();
  });

  it.each([
    ['none', { lines: [] }, /at least one line/],
    ['201 lines', { lines: Array(201).fill({ account: '6000', month: '2026-03' }) }, /At most 200 lines/],
    ['16 months apart', { lines: [{ account: '6000', month: '2026-03' }, { account: '6000', month: '2027-06' }] }, /span/i],
  ])('the app\'s bounds: %s', async (_n, args, why) => {
    expect(text(await budgetRemainingTool.handler(args, ctx('manager', ['read:reports'])))).toMatch(why);
    expect(remainingFor).not.toHaveBeenCalled();
  });

  it('lines as the app takes them: a cc1 AND a bu, a balance-sheet account; an unknown code refused in place', async () => {
    vi.mocked(remainingFor).mockImplementation(async (_c, keys) => keys.map((key) => result({ key, budget: 1000, actual: 250.5, remaining: 749.5, grain: 'cc1', slice: { cc1Id: CC1, cc2Id: null, buId: null } })));
    const out = json(await budgetRemainingTool.handler({ lines: [
      { account: '6000', cc1: 'C1', bu: 'B', month: '2026-03' }, { account: '1000', month: '2026-03' }, { account: 'NOPE', month: '2026-03' },
    ] }, ctx('manager', ['read:reports'])));
    expect(vi.mocked(remainingFor).mock.calls[0]![1]).toEqual([
      { glAccountId: RENT, cc1Id: CC1, cc2Id: null, buId: BU, month: '2026-03' }, { glAccountId: BANK, cc1Id: null, cc2Id: null, buId: null, month: '2026-03' },
    ]);
    expect(out.lines).toEqual([
      expect.objectContaining({ i: 0, budget: '1000.00', actual: '250.50', committed: '0.00', remaining: '749.50', grain: 'cc1', slice: { cc1: 'C1', cc2: null, bu: null } }),
      expect.objectContaining({ i: 1, account: '1000' }),
      expect.objectContaining({ i: 2, refused: 'NOPE is not an account of this company' }),
    ]);
  });

  it('a numeric account or member code sent as a JSON number is read as its text (review round 2, L-3)', async () => {
    vi.mocked(loadChartRefs).mockResolvedValue({ accounts: [{ id: RENT, code: '7777' }], members: [{ id: BU, code: '42', kind: 'bu' }] });
    vi.mocked(remainingFor).mockImplementation(async (_c, keys) => keys.map((key) => result({ key })));
    const out = json(await budgetRemainingTool.handler({ lines: [{ account: 7777, bu: 42, month: '2026-03' }] }, ctx('manager', ['read:reports'])));
    expect(vi.mocked(remainingFor).mock.calls[0]![1]).toEqual([{ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: BU, month: '2026-03' }]);
    expect(out).toMatchObject({ answered: 1, refused: 0, lines: [{ i: 0, account: '7777' }] });
  });

  it('a TrackingError from the service is answered as the route answers it (its message)', async () => {
    vi.mocked(remainingFor).mockRejectedValue(new TrackingError(409, 'No financial year holds 2026-03-01'));
    const r = await budgetRemainingTool.handler({ lines: [{ account: '6000', month: '2026-03' }] }, ctx('manager', ['read:reports']));
    expect([r.isError, text(r)]).toEqual([true, 'No financial year holds 2026-03-01']);
  });

  it('the mcp-budget-remaining bucket (the route\'s 120 a minute) refuses before any read', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    expect(text(await budgetRemainingTool.handler({ lines: [{ account: '6000', month: '2026-03' }] }, ctx('manager', ['read:reports'])))).toMatch(/Too many budget previews/);
    expect(checkRateLimit).toHaveBeenCalledWith('mcp-budget-remaining:u-1', { max: 120, windowSecs: 60 });
    expect(remainingFor).not.toHaveBeenCalled();
  });
});

describe('budget_tracking', () => {
  const alert = (i: number) => ({ id: `a${i}`, versionId: VERSION, glAccountId: RENT, accountCode: '6000', accountName: 'Rent', cc1Id: null, cc2Id: null, buId: null,
    sliceName: null, month: '2026-03', threshold: 100, budget: 1000, actual: 1200.5, committed: 0, pct: 120.05, firedAt: '2026-03-31T00:00:00.000Z', resolvedAt: null, href: '/x' });

  it('its roles are exactly the app alerts route\'s (BUDGET_CONTROL_ADMIN_ROLES = WITH_ROLE_ADMITS.admin)', () => {
    expect([...BUDGET_CONTROL_ADMIN_ROLES].sort()).toEqual([...WITH_ROLE_ADMITS.admin].sort());
    expect(budgetTrackingTool.requiresRole).toBe('admin');
    expect(budgetTrackingTool.description).toMatch(/^Overspend alerts only; for budget vs actual use budget_variance/);
  });

  it.each(['manager', 'viewer'])('%s is refused by the registry before the real handler reads anything', async (role) => {
    const out = await registryWith(budgetTrackingTool).call('budget_tracking', {}, ctx(role, ['read:reports']));
    expect([out.isError, text(out)]).toEqual([true, expect.stringMatching(/only by the owner and admin roles/)]);
    expect(listBudgetAlerts).not.toHaveBeenCalled();
  });

  it('pages the open alerts with figures as decimal text, totals over both lists and the last evaluation', async () => {
    vi.mocked(listBudgetAlerts).mockResolvedValue({ open: Array.from({ length: 70 }, (_, i) => alert(i)), resolved: [alert(99)], lastEvaluated: { daily: null, manual: null } } as never);
    const out = json(await budgetTrackingTool.handler({ limit: 50 }, ctx('admin', ['read:reports'])));
    expect(out).toMatchObject({ status: 'open', total: 70, next_offset: 50, open_total: 70, resolved_total: 1 });
    expect((out.items as unknown[])[0]).toMatchObject({ account: '6000', threshold: 100, budget: '1000.00', actual: '1200.50', pct: 120.05 });
  });
});

describe('submit_budget_for_review', () => {
  it('a viewer is fenced by the registry before the real handler reads anything', async () => {
    expect((await registryWith(submitBudgetForReviewTool).call('submit_budget_for_review', { version_id: VERSION, idempotency_key: 'k' }, ctx('viewer'))).isError).toBe(true);
    expect(listSlices).not.toHaveBeenCalled();
    expect(transitionSlice).not.toHaveBeenCalled();
  });

  it('by version: the holder\'s one open slice is submitted as the token user', async () => {
    vi.mocked(listSlices).mockResolvedValue([slice(), slice({ id: 'other', holders: [{ id: 'h2', userId: 'u-2', name: null, glAccountIds: null }] })] as never);
    vi.mocked(transitionSlice).mockResolvedValue(slice({ status: 'submitted' }) as never);
    const out = json(await submitBudgetForReviewTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx('manager')));
    expect(transitionSlice).toHaveBeenCalledWith(expect.anything(), SLICE, 'submit', { userId: 'u-1', role: 'manager' });
    expect(out).toMatchObject({ slice: { id: SLICE, status: 'submitted', label: 'CC1 C1 Centre' } });
  });

  it('by version: none, or several, is refused with the list; nothing submitted', async () => {
    vi.mocked(listSlices).mockResolvedValue([] as never);
    expect(text(await submitBudgetForReviewTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx('manager')))).toMatch(/hold no open or returned budget slice/);
    vi.mocked(listSlices).mockResolvedValue([slice(), slice({ id: 'second', status: 'returned' })] as never);
    expect(text(await submitBudgetForReviewTool.handler({ version_id: VERSION, idempotency_key: 'k' }, ctx('manager')))).toMatch(/2 budget slices.*slice_id/);
    expect(transitionSlice).not.toHaveBeenCalled();
  });

  it('the dry run submits rolled back and frees the key; a refusal is answered; the mcp-budget-slice bucket', async () => {
    vi.mocked(readSlice).mockResolvedValue(slice() as never);
    vi.mocked(transitionSlice).mockResolvedValue(slice({ status: 'submitted' }) as never);
    const r = await submitBudgetForReviewTool.handler({ slice_id: SLICE, dry_run: true, idempotency_key: 'k' }, ctx('manager'));
    expect([r.wroteNothing, json(r).dry_run]).toEqual([true, true]);
    vi.mocked(transitionSlice).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'Only a holder of this budget slice can submit it'));
    expect(text(await submitBudgetForReviewTool.handler({ slice_id: SLICE, dry_run: true, idempotency_key: 'k' }, ctx('manager')))).toMatch(/would be refused: Only a holder/);
    vi.mocked(checkRateLimit).mockResolvedValue(false);
    expect(text(await submitBudgetForReviewTool.handler({ slice_id: SLICE, idempotency_key: 'k' }, ctx('manager')))).toMatch(/Too many budget slice changes/);
    expect(checkRateLimit).toHaveBeenLastCalledWith('mcp-budget-slice:u-1', { max: 60, windowSecs: 60 });
  });

  it("another company's slice is the shared Not found", async () => {
    vi.mocked(readSlice).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_NOT_FOUND', 'Budget slice not found'));
    expect(text(await submitBudgetForReviewTool.handler({ slice_id: SLICE, idempotency_key: 'k' }, ctx('manager')))).toBe('Not found');
  });
});

describe('replay and the freed key, through the registry with the real handler', () => {
  beforeEach(() => {
    vi.mocked(readSlice).mockResolvedValue(slice() as never);
    vi.mocked(transitionSlice).mockResolvedValue(slice({ status: 'submitted' }) as never);
  });
  const submit = (extra: Record<string, unknown>) => registryWith(submitBudgetForReviewTool).call('submit_budget_for_review', { slice_id: SLICE, idempotency_key: 'k', ...extra }, ctx('manager'));

  it('a stored live result is replayed for the same key: the service is not called again', async () => {
    audit.findIdempotentReplay.mockResolvedValueOnce({ status: 'match', result: { content: [{ type: 'text', text: '{"slice":"stored"}' }] } } as never);
    expect(text(await submit({}))).toBe('{"slice":"stored"}');
    expect(transitionSlice).not.toHaveBeenCalled();
  });

  it.each([
    ['a dry run (wroteNothing)', { dry_run: true }, null, 'ok'],
    ['a refusal (none submittable)', { slice_id: undefined, version_id: VERSION }, null, 'rejected'],
    ['a live submit', {}, 'k', 'ok'],
  ])('%s is recorded with key %s', async (_n, extra, keyStored, status) => {
    vi.mocked(listSlices).mockResolvedValue([] as never);
    await submit(extra);
    expect(audit.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: keyStored, status }));
  });
});
