/**
 * D4 round 6 (security review of 741f9d493):
 *  LOW-1 — group_id / body groupId / adjustmentId are UUID-checked (typeof first) before any
 *          query; a malformed or repeated value used to reach a ::UUID cast and 500. A POST with
 *          no body used to TypeError on req.body.groupId.
 *  LOW-2 — elimination writes (create / post / reverse / auto-eliminate) need a write role
 *          (owner / admin / manager) in a CURRENT member company of the group, not just
 *          membership: a viewer could post eliminations. Reads stay membership-only.
 *  Plus the create body is shape-checked (typeof) before the insert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  getConsolidatedTrialBalance: vi.fn(), getConsolidatedIncomeStatement: vi.fn(), getConsolidatedBalanceSheet: vi.fn(),
  getGroupDashboardStats: vi.fn(), getEliminationAdjustments: vi.fn(), createEliminationAdjustment: vi.fn(),
  postEliminationAdjustment: vi.fn(), reverseEliminationAdjustment: vi.fn(), autoGenerateEliminations: vi.fn(),
}));
const access = vi.hoisted(() => ({ userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/consolidatedReportingService', () => svc);

import handler from '../../../pages/api/accounting/consolidated-reports';

const GROUP = '80000000-0000-4000-8000-000000000001';
const ADJ = '70000000-0000-4000-8000-000000000001';
const ACCT = '81000000-0000-4000-8000-000000000001';

async function call(method: string, query: Record<string, unknown>, body?: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method, user: { id: 'u1' }, query, body } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const message = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});
const anyService = () => Object.values(svc).some(fn => fn.mock.calls.length > 0);

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue([]);
  access.userBelongsToGroup.mockReset().mockResolvedValue(true);
  access.userCanWriteGroup.mockReset().mockResolvedValue(true);
});

const VALID_CREATE = { action: 'create-elimination', adjustmentType: 'interco_revenue', description: 'x',
  periodStart: '2026-01-31', periodEnd: '2026-01-31',
  lines: [{ groupAccountId: ACCT, debit: 10, credit: 0 }, { groupAccountId: ACCT, debit: 0, credit: 10 }] };

describe('LOW-1: ids are UUID-checked before any query', () => {
  it.each(['abc', [GROUP, GROUP], ''])('GET group_id %j → 400', async (gid) => {
    const res = await call('GET', { group_id: gid, action: 'dashboard' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(message(res)).toContain('group_id');
    expect(access.userBelongsToGroup).not.toHaveBeenCalled();
  });

  it.each([{ groupId: 'abc' }, { groupId: [GROUP] }, undefined])('POST group id %j → 400 (no body is not a TypeError)', async (body) => {
    const res = await call('POST', { action: 'auto-eliminate' }, body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(access.userBelongsToGroup).not.toHaveBeenCalled();
  });

  it.each(['post-elimination', 'reverse-elimination'])('%s with a malformed adjustmentId → 400', async (action) => {
    for (const adjustmentId of ['x', [ADJ], 7, undefined]) {
      const res = await call('POST', { group_id: GROUP }, { action, adjustmentId });
      expect(res.status, JSON.stringify(adjustmentId)).toHaveBeenCalledWith(400);
    }
    expect(anyService()).toBe(false);
  });

  it('a valid group id and adjustment id pass through', async () => {
    const res = await call('POST', { group_id: GROUP }, { action: 'post-elimination', adjustmentId: ADJ });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc.postEliminationAdjustment).toHaveBeenCalledWith(ADJ, GROUP);
  });
});

describe('LOW-2: elimination writes need a write role in the group', () => {
  const writes: Array<[string, Record<string, unknown>, keyof typeof svc]> = [
    ['create-elimination', VALID_CREATE, 'createEliminationAdjustment'],
    ['post-elimination', { action: 'post-elimination', adjustmentId: ADJ }, 'postEliminationAdjustment'],
    ['reverse-elimination', { action: 'reverse-elimination', adjustmentId: ADJ }, 'reverseEliminationAdjustment'],
    ['auto-eliminate', { action: 'auto-eliminate', periodStart: '2026-01-01', periodEnd: '2026-01-31' }, 'autoGenerateEliminations'],
  ];

  it.each(writes)('%s: a viewer-only member is refused 403 before the write', async (_a, body, fn) => {
    access.userCanWriteGroup.mockResolvedValue(false);
    const res = await call('POST', { group_id: GROUP }, body);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(svc[fn]).not.toHaveBeenCalled();
    expect(access.userCanWriteGroup).toHaveBeenCalledWith('u1', GROUP);
  });

  it.each(writes)('%s: a writer is allowed', async (_a, body, fn) => {
    const res = await call('POST', { group_id: GROUP }, body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc[fn]).toHaveBeenCalledTimes(1);
  });

  it('reads stay membership-only: a viewer can still load the eliminations list', async () => {
    access.userCanWriteGroup.mockResolvedValue(false);
    const res = await call('GET', { group_id: GROUP, action: 'eliminations' });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('create-elimination body is shape-checked before the insert', () => {
  it.each([
    [{ adjustmentType: 7 }, 'adjustmentType'],
    [{ description: ['x'] }, 'description'],
    [{ lines: 'x' }, 'lines'],
    [{ lines: [{ groupAccountId: 'G4000', debit: 10, credit: 0 }] }, 'groupAccountId'],
    [{ lines: [{ groupAccountId: ACCT, debit: '10', credit: 0 }] }, 'debit'],
    [{ lines: [{ groupAccountId: ACCT, debit: 10, credit: -1 }] }, 'credit'],
  ])('%j → 400', async (patch, field) => {
    const res = await call('POST', { group_id: GROUP }, { ...VALID_CREATE, ...patch });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(message(res)).toContain(field);
    expect(svc.createEliminationAdjustment).not.toHaveBeenCalled();
  });
});
