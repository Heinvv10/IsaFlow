/**
 * Manual elimination of a MIRRORED row is not supported yet (docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md): the
 * create-elimination route answers 400 to any body that names an intercompany row (sourceIntercompanyId), with the reason code, the way out and the
 * design doc, before it reads or writes anything; the service's own refusal of a mirrored row is mapped the same way. A plain manual elimination
 * (no row) is unaffected.
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
const groupAccounts = vi.hoisted(() => ({ getGroupAccounts: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/groupCompanyService', () => groupAccounts);

import handler from '../../../pages/api/accounting/consolidated-reports';
import { EliminationMirroredRowUnsupportedError, MIRRORED_ROW_MANUAL_ELIMINATION_DOC } from '@/modules/accounting/services/reports/eliminationErrors';

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
const payload = (res: { json: ReturnType<typeof vi.fn> }) => JSON.stringify(res.json.mock.calls[0]?.[0] ?? {});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue({ id: 'adj' });
  access.userBelongsToGroup.mockReset().mockResolvedValue(true);
  access.userCanWriteGroup.mockReset().mockResolvedValue(true);
  groupAccounts.getGroupAccounts.mockReset().mockResolvedValue([{ id: ACCT, groupId: GROUP }]);
  dupes.cutoverRequiringReason.mockReset().mockResolvedValue(null);
});

describe('create-elimination naming an intercompany row', () => {
  it.each([ROW, 'not-a-uuid', 7, [ROW], '', false])('sourceIntercompanyId %j → 400 with the reason code, the way out and the design doc; nothing is written', async (id) => {
    const res = await call({ ...BODY, sourceIntercompanyId: id, manualReason: 'The receiver booked it in January' });
    expect(res.status).toHaveBeenCalledWith(400);
    const text = payload(res);
    expect(text).toContain('mirrored_row_manual_elimination_unsupported');
    expect(text).toMatch(/not supported yet/);
    expect(text).toMatch(/Correct or re-accept the receiving company's document \(or cancel the sale\) so that mirroring eliminates it/);
    expect(text).toContain(MIRRORED_ROW_MANUAL_ELIMINATION_DOC);
    expect(svc.createEliminationAdjustment).not.toHaveBeenCalled();
  });

  it('is refused before the group\'s accounts are even read', async () => {
    await call({ ...BODY, sourceIntercompanyId: ROW });
    expect(groupAccounts.getGroupAccounts).not.toHaveBeenCalled();
  });

  it('a null sourceIntercompanyId is the same as none: a plain manual elimination is stored, carrying no row', async () => {
    for (const body of [BODY, { ...BODY, sourceIntercompanyId: null }]) {
      svc.createEliminationAdjustment.mockClear();
      const res = await call(body);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(svc.createEliminationAdjustment.mock.calls[0]![1]).not.toHaveProperty('sourceIntercompanyId');
    }
  });

  it('the service\'s own refusal of a mirrored row (a row named some other way) is answered the same 400', async () => {
    svc.createEliminationAdjustment.mockRejectedValueOnce(new EliminationMirroredRowUnsupportedError(ROW));
    const res = await call(BODY);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payload(res)).toContain('mirrored_row_manual_elimination_unsupported');
  });
});
