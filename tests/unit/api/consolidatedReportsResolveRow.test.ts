/**
 * Round 22 M-1: a manual elimination of a mirrored row no path eliminates carries the row (sourceIntercompanyId). The route validates it (a UUID,
 * a reason always), asks assertMirroredRowResolvable before the insert, passes the id on, and answers the typed refusals 400 / 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  getConsolidatedTrialBalance: vi.fn(), getConsolidatedIncomeStatement: vi.fn(), getConsolidatedBalanceSheet: vi.fn(),
  getGroupDashboardStats: vi.fn(), getEliminationAdjustments: vi.fn(), createEliminationAdjustment: vi.fn(),
  postEliminationAdjustment: vi.fn(), reverseEliminationAdjustment: vi.fn(), autoGenerateEliminations: vi.fn(),
}));
const access = vi.hoisted(() => ({ userBelongsToGroup: vi.fn(), userCanWriteGroup: vi.fn() }));
vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApproveInGroup: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => access);
vi.mock('@/modules/accounting/services/reports/consolidatedReportingService', () => svc);
const dupes = vi.hoisted(() => ({ cutoverRequiringReason: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('@/modules/accounting/services/reports/eliminationDuplicates', () => dupes);
const resolve = vi.hoisted(() => ({ assertMirroredRowResolvable: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/eliminationResolve', () => resolve);
const groupAccounts = vi.hoisted(() => ({ getGroupAccounts: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => groupAccounts);

import handler from '../../../pages/api/accounting/consolidated-reports';
import { EliminationAlreadyStandsError, EliminationSourceError } from '@/modules/accounting/services/reports/eliminationErrors';

const GROUP = '80000000-0000-4000-8000-000000000001';
const ACCT = '81000000-0000-4000-8000-000000000001';
const ROW = '90000000-0000-4000-8000-000000000001';
const BODY = { action: 'create-elimination', adjustmentType: 'interco_revenue', description: 'x', periodStart: '2026-12-30', periodEnd: '2026-12-30',
  lines: [{ groupAccountId: ACCT, debit: 10, credit: 0 }, { groupAccountId: ACCT, debit: 0, credit: 10 }] };

async function call(body: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'POST', user: { id: 'u1' }, query: { group_id: GROUP }, body } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const message = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue({ id: 'adj' });
  access.userBelongsToGroup.mockReset().mockResolvedValue(true);
  access.userCanWriteGroup.mockReset().mockResolvedValue(true);
  groupAccounts.getGroupAccounts.mockReset().mockResolvedValue([{ id: ACCT, groupId: GROUP }]);
  dupes.cutoverRequiringReason.mockReset().mockResolvedValue(null);
  resolve.assertMirroredRowResolvable.mockReset().mockResolvedValue(undefined);
});

describe('create-elimination with sourceIntercompanyId', () => {
  it('checks the row for the elimination\'s period, then stores the elimination carrying the row and the reason', async () => {
    const res = await call({ ...BODY, sourceIntercompanyId: ROW, manualReason: '  The receiver booked it in January  ' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resolve.assertMirroredRowResolvable).toHaveBeenCalledWith(GROUP, ROW, '2026-12-30', '2026-12-30');
    expect(svc.createEliminationAdjustment).toHaveBeenCalledWith(GROUP, expect.objectContaining({ sourceIntercompanyId: ROW, manualReason: 'The receiver booked it in January' }));
  });

  it.each(['x', 7, [ROW], null])('a malformed id %j → 400, nothing written', async (id) => {
    const res = await call({ ...BODY, sourceIntercompanyId: id, manualReason: 'because of this' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(message(res)).toContain('sourceIntercompanyId');
    expect(svc.createEliminationAdjustment).not.toHaveBeenCalled();
  });

  it('a reason is ALWAYS required when it carries a row (the group has no cutover here), 400 before any check', async () => {
    const res = await call({ ...BODY, sourceIntercompanyId: ROW, manualReason: ' no ' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(message(res)).toContain('needs a reason');
    expect(resolve.assertMirroredRowResolvable).not.toHaveBeenCalled();
    expect(svc.createEliminationAdjustment).not.toHaveBeenCalled();
  });

  it('without the field nothing is checked and no source is stored (a plain manual elimination)', async () => {
    const res = await call(BODY);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(resolve.assertMirroredRowResolvable).not.toHaveBeenCalled();
    expect(svc.createEliminationAdjustment.mock.calls[0]![1]).not.toHaveProperty('sourceIntercompanyId');
  });

  it('a row that is not this group\'s mirrored row → 400; one whose elimination stands (also the index\'s 23505) → 409; nothing is written', async () => {
    resolve.assertMirroredRowResolvable.mockRejectedValueOnce(new EliminationSourceError(ROW, 'it is dated elsewhere'));
    const bad = await call({ ...BODY, sourceIntercompanyId: ROW, manualReason: 'because of this' });
    expect(bad.status).toHaveBeenCalledWith(400);
    expect(message(bad)).toContain('bad_source_row');
    resolve.assertMirroredRowResolvable.mockRejectedValueOnce(new EliminationAlreadyStandsError(ROW));
    const stands = await call({ ...BODY, sourceIntercompanyId: ROW, manualReason: 'because of this' });
    expect(stands.status).toHaveBeenCalledWith(409);
    expect(message(stands)).toContain('already_stands');
    svc.createEliminationAdjustment.mockRejectedValueOnce(new EliminationAlreadyStandsError(ROW));
    const raced = await call({ ...BODY, sourceIntercompanyId: ROW, manualReason: 'because of this' });
    expect(raced.status).toHaveBeenCalledWith(409);
  });
});
