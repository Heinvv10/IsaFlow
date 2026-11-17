/**
 * budget_remaining, budget_tracking and submit_budget_for_review (MCP budget tools PR 3), services mocked:
 *  - budget_remaining: budget writers only (the app's preview is withWriteAccess), the app's bounds (200 lines,
 *    a 12-month span), accounts and members by id or code per row (unknown / non-P&L / two dimensions refused per
 *    row, the rest answered), figures as decimal text, a registry miss answered;
 *  - budget_tracking: the overspend alerts as the controls page lists them; owner / admin only, fenced by the
 *    registry before the handler (as the app's alerts route); paged;
 *  - submit_budget_for_review: the holder's own open / returned slice by version, or a slice id; several or none
 *    is refused with the list; approve / return are not offered; dry run rolled back; the service's refusal reaches
 *    the agent; a viewer is fenced before the handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const audit = vi.hoisted(() => ({ recordToolCall: vi.fn(async () => undefined), acquireIdempotencyLock: vi.fn(async () => undefined), findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })) }));
vi.mock('@/lib/mcp/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp/audit')>()), ...audit }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/remainingBudget', async (orig) => ({ ...(await orig<object>()), remainingFor: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/tracking/trackingWindow', async (orig) => ({ ...(await orig<object>()), registryYears: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetAlertList', async (orig) => ({ ...(await orig<object>()), listBudgetAlerts: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/sliceReviewRead', () => ({ readSlice: vi.fn(), listSlices: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/sliceReviewState', async (orig) => ({ ...(await orig<object>()), transitionSlice: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { registryYears } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { listBudgetAlerts } from '@/modules/accounting/services/budgets/budgetAlertList';
import { listSlices, readSlice } from '@/modules/accounting/services/budgets/sliceReviewRead';
import { transitionSlice } from '@/modules/accounting/services/budgets/sliceReviewState';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { McpRegistry } from '@/lib/mcp/registry';
import { budgetRemainingTool, budgetTrackingTool } from '@/lib/mcp/tools/budgetControlTools';
import { submitBudgetForReviewTool } from '@/lib/mcp/tools/budgetSliceTools';
import { setBudgetDriversTool } from '@/lib/mcp/tools/budgetDriverWrite';
import { CC1, RENT, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

const SLICE = '40000000-0000-4000-8000-000000000001';
const slice = (over: Record<string, unknown> = {}) => ({
  id: SLICE, versionId: VERSION, versionName: 'Budget', fiscalYear: 2027, versionStatus: 'draft', cc1Id: CC1, cc2Id: null, buId: null,
  label: 'CC1 C1 Centre', status: 'open', dueDate: null, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null, decisionNote: null,
  holders: [{ id: 'h', userId: 'u-1', name: 'Me', glAccountIds: null }], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  vi.mocked(registryYears).mockReturnValue({ forDate: vi.fn(async () => ({ fiscalYear: 2027 })), byLabel: vi.fn() } as never);
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

  it('resolves by code per row, refuses a bad row in place, answers the rest as decimal text', async () => {
    vi.mocked(remainingFor).mockResolvedValue([{
      key: { glAccountId: RENT, cc1Id: CC1, cc2Id: null, buId: null, month: '2026-03' }, versionId: VERSION, grain: 'cc1',
      slice: { cc1Id: CC1, cc2Id: null, buId: null }, unassigned: false, offSlice: false, budget: 1000, actual: 250.5, committed: 0, remaining: 749.5,
    }]);
    const out = json(await budgetRemainingTool.handler({ lines: [
      { account: '6000', cc1: 'C1', month: '2026-03' }, { account: '6000', cc1: 'C1', bu: 'B', month: '2026-03' }, { account: '7000', month: '2026-03' },
    ] }, ctx('manager', ['read:reports'])));
    expect(vi.mocked(remainingFor).mock.calls[0]![1]).toEqual([{ glAccountId: RENT, cc1Id: CC1, cc2Id: null, buId: null, month: '2026-03' }]);
    expect(out.lines).toEqual([
      expect.objectContaining({ i: 0, account: '6000', month: '2026-03', budget: '1000.00', actual: '250.50', committed: '0.00', remaining: '749.50', grain: 'cc1', slice: { cc1: 'C1', cc2: null, bu: null } }),
      expect.objectContaining({ i: 1, refused: expect.stringMatching(/at most one dimension/) }),
      expect.objectContaining({ i: 2, refused: expect.stringMatching(/header account/) }),
    ]);
  });

  it('a month no financial year holds is refused for that row', async () => {
    vi.mocked(registryYears).mockReturnValue({ forDate: vi.fn(async () => { throw new TrackingError(409, 'No financial year holds 2026-03-01'); }), byLabel: vi.fn() } as never);
    const out = json(await budgetRemainingTool.handler({ lines: [{ account: '6000', month: '2026-03' }] }, ctx('manager', ['read:reports'])));
    expect(out.lines).toEqual([expect.objectContaining({ i: 0, refused: 'No financial year holds 2026-03-01' })]);
    expect(remainingFor).not.toHaveBeenCalled();
  });
});

describe('budget_tracking', () => {
  const alert = (i: number) => ({ id: `a${i}`, versionId: VERSION, glAccountId: RENT, accountCode: '6000', accountName: 'Rent', cc1Id: null, cc2Id: null, buId: null,
    sliceName: null, month: '2026-03', threshold: 100, budget: 1000, actual: 1200.5, committed: 0, pct: 120.05, firedAt: '2026-03-31T00:00:00.000Z', resolvedAt: null, href: '/x' });

  it.each(['manager', 'viewer'])('%s is refused by the registry before the handler (owners and admins, as the app)', async (role) => {
    const r = new McpRegistry();
    const handler = vi.fn();
    r.register({ ...budgetTrackingTool, handler });
    const out = await r.call('budget_tracking', {}, ctx(role, ['read:reports']));
    expect([out.isError, text(out)]).toEqual([true, expect.stringMatching(/only by the owner and admin roles/)]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('pages the open alerts with figures as decimal text, totals over both lists and the last evaluation', async () => {
    vi.mocked(listBudgetAlerts).mockResolvedValue({ open: Array.from({ length: 70 }, (_, i) => alert(i)), resolved: [alert(99)], lastEvaluated: { daily: null, manual: null } } as never);
    const out = json(await budgetTrackingTool.handler({ limit: 50 }, ctx('admin', ['read:reports'])));
    expect(out).toMatchObject({ status: 'open', total: 70, next_offset: 50, open_total: 70, resolved_total: 1 });
    expect((out.items as unknown[])[0]).toMatchObject({ account: '6000', threshold: 100, budget: '1000.00', actual: '1200.50', pct: 120.05 });
  });
});

describe('submit_budget_for_review', () => {
  it('a viewer is fenced by the registry before the handler', async () => {
    const r = new McpRegistry();
    const handler = vi.fn();
    r.register({ ...submitBudgetForReviewTool, handler });
    expect((await r.call('submit_budget_for_review', { version_id: VERSION, idempotency_key: 'k' }, ctx('viewer'))).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
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

  it('the dry run submits rolled back and frees the key; a refusal is answered', async () => {
    vi.mocked(readSlice).mockResolvedValue(slice() as never);
    vi.mocked(transitionSlice).mockResolvedValue(slice({ status: 'submitted' }) as never);
    const r = await submitBudgetForReviewTool.handler({ slice_id: SLICE, dry_run: true, idempotency_key: 'k' }, ctx('manager'));
    expect([r.wroteNothing, json(r).dry_run]).toEqual([true, true]);
    vi.mocked(transitionSlice).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'Only a holder of this budget slice can submit it'));
    expect(text(await submitBudgetForReviewTool.handler({ slice_id: SLICE, dry_run: true, idempotency_key: 'k' }, ctx('manager')))).toMatch(/would be refused: Only a holder/);
  });

  it("another company's slice is the shared Not found", async () => {
    vi.mocked(readSlice).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_NOT_FOUND', 'Budget slice not found'));
    expect(text(await submitBudgetForReviewTool.handler({ slice_id: SLICE, idempotency_key: 'k' }, ctx('manager')))).toBe('Not found');
  });
});

describe('PR 3 writes through the real registry: replay and the freed key', () => {
  const stored = { content: [{ type: 'text' as const, text: '{"saved":true}' }] };
  it('a stored live result is replayed for the same key without running the handler', async () => {
    const r = new McpRegistry();
    const handler = vi.fn();
    r.register({ ...setBudgetDriversTool, handler });
    audit.findIdempotentReplay.mockResolvedValueOnce({ status: 'match', result: stored } as never);
    expect(text(await r.call('set_budget_drivers', { version_id: VERSION, changes: [{ op: 'refresh_headcount' }], idempotency_key: 'k' }, ctx('manager')))).toBe('{"saved":true}');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['a dry run (wroteNothing)', { ...stored, wroteNothing: true }, null, 'ok'],
    ['a refusal', { ...stored, isError: true }, null, 'rejected'],
    ['a write', stored, 'k', 'ok'],
  ])('%s is recorded with key %s', async (_n, result, keyStored, status) => {
    const r = new McpRegistry();
    r.register({ ...submitBudgetForReviewTool, handler: vi.fn(async () => result) });
    await r.call('submit_budget_for_review', { slice_id: SLICE, idempotency_key: 'k' }, ctx('manager'));
    expect(audit.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: keyStored, status }));
  });
});
