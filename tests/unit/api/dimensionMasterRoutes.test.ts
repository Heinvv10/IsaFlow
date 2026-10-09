/**
 * #678 review M6 / M4 / L5: the four dimension-master routes, real handlers
 * with the services mocked. What the form sends becomes the service input
 * (absent = unchanged, '' = clear, a value = set); a refusal is a 400 with its
 * own message, logged as a warning; anything else is the generic 400, logged as
 * an error; a toggle to the state a centre already has is a 200.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionMasterEdit', () => ({
  planUpdateDimensionCostCentre: vi.fn(), applyUpdateDimensionCostCentre: vi.fn(),
  planDeleteDimensionCostCentre: vi.fn(), applyDeleteDimensionCostCentre: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionMasterService', () => ({
  listDimensionCostCentres: vi.fn(async () => []), planCreateDimensionCostCentre: vi.fn(), applyCreateDimensionCostCentre: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/costCentreService', () => ({ getCostCentres: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/core/businessUnitService', async (orig) => ({
  BusinessUnitActionError: (await orig<typeof import('@/modules/accounting/services/core/businessUnitService')>()).BusinessUnitActionError,
  getBusinessUnits: vi.fn(async () => []), createBusinessUnit: vi.fn(),
  planUpdateBusinessUnit: vi.fn(), applyUpdateBusinessUnit: vi.fn(), deleteBusinessUnit: vi.fn(),
}));

import costCentresAction from '../../../pages/api/accounting/cost-centres-action';
import costCentres from '../../../pages/api/accounting/cost-centres';
import businessUnitsAction from '../../../pages/api/accounting/business-units-action';
import businessUnits from '../../../pages/api/accounting/business-units';
import {
  applyDeleteDimensionCostCentre, applyUpdateDimensionCostCentre, planDeleteDimensionCostCentre, planUpdateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { listDimensionCostCentres, planCreateDimensionCostCentre } from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import {
  applyUpdateBusinessUnit, BusinessUnitActionError, createBusinessUnit, deleteBusinessUnit, planUpdateBusinessUnit,
} from '@/modules/accounting/services/core/businessUnitService';
import { CostCentreActionError } from '@/modules/accounting/services/core/costCentreUsageGuard';
import { DimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

type Handler = (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>;
async function call(handler: unknown, method: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  const req = { method, query, body, companyId: 'co-1', user: { id: 'user-1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  await (handler as Handler)(req, res as unknown as NextApiResponse);
  const sent = res.sent as { data?: unknown; error?: { message?: string } };
  return { status: res.statusCode, data: sent?.data, message: sent?.error?.message };
}

const PLAN = { before: { id: 'cc-1' }, after: { code: 'C' }, changed: [] as string[], warnings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(planUpdateDimensionCostCentre).mockResolvedValue(PLAN as never);
  vi.mocked(planUpdateBusinessUnit).mockResolvedValue({ before: { id: 'bu-1' }, changed: [] } as never);
  vi.mocked(applyUpdateBusinessUnit).mockResolvedValue({ id: 'bu-1' } as never);
});

describe('cost-centres-action', () => {
  it('update: absent stays absent, \'\' clears the parent, a value sets it; aliases pass as a list', async () => {
    await call(costCentresAction, 'POST', { action: 'update', id: 'cc-1', name: 'N' });
    const first = vi.mocked(planUpdateDimensionCostCentre).mock.calls[0]![2];
    expect(first).toEqual({ code: undefined, name: 'N', description: undefined, department: undefined });
    expect('parent' in first).toBe(false);
    await call(costCentresAction, 'POST', { action: 'update', id: 'cc-1', parent: '  ', description: '', aliases: ['A', 3] });
    expect(vi.mocked(planUpdateDimensionCostCentre).mock.calls[1]![2]).toMatchObject({ parent: null, description: '', aliases: ['A'] });
    await call(costCentresAction, 'POST', { action: 'update', id: 'cc-1', parent: 'FT001' });
    expect(vi.mocked(planUpdateDimensionCostCentre).mock.calls[2]![2]).toMatchObject({ parent: 'FT001' });
  });

  it('toggle: a toggle to the current state (no change) is a 200 (M4); isActive false deactivates, absent activates', async () => {
    const r = await call(costCentresAction, 'POST', { action: 'toggle', id: 'cc-1', isActive: true });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ toggled: true });
    expect(planUpdateDimensionCostCentre).toHaveBeenLastCalledWith('co-1', 'cc-1', { isActive: true });
    await call(costCentresAction, 'POST', { action: 'toggle', id: 'cc-1', isActive: false });
    expect(planUpdateDimensionCostCentre).toHaveBeenLastCalledWith('co-1', 'cc-1', { isActive: false });
    await call(costCentresAction, 'POST', { action: 'toggle', id: 'cc-1' });
    expect(planUpdateDimensionCostCentre).toHaveBeenLastCalledWith('co-1', 'cc-1', { isActive: true });
  });

  it('delete plans (counted guard), then applies', async () => {
    vi.mocked(planDeleteDimensionCostCentre).mockResolvedValue({ id: 'cc-1' } as never);
    const r = await call(costCentresAction, 'POST', { action: 'delete', id: 'cc-1' });
    expect(r.status).toBe(200);
    expect(applyDeleteDimensionCostCentre).toHaveBeenCalledWith('co-1', { id: 'cc-1' }, 'user-1');
  });

  it.each([
    ['a dimension refusal', new DimensionRefusal('parent "X" is FT-LAW itself or below it — that would make a loop')],
    ['a usage refusal', new CostCentreActionError('Cannot delete cost centre that is used by 2 journal line(s). Deactivate instead.')],
  ])('%s is a 400 with its message, logged as a warning (L5)', async (_l, err) => {
    vi.mocked(planDeleteDimensionCostCentre).mockRejectedValueOnce(err);
    const r = await call(costCentresAction, 'POST', { action: 'delete', id: 'cc-1' });
    expect(r).toMatchObject({ status: 400, message: err.message });
    expect(log.warn).toHaveBeenCalledWith('Cost centre action refused', expect.anything(), 'accounting-api');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('an unexpected error stays generic and is logged as an error', async () => {
    vi.mocked(applyUpdateDimensionCostCentre).mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const r = await call(costCentresAction, 'POST', { action: 'update', id: 'cc-1', name: 'N' });
    expect(r).toMatchObject({ status: 400, message: 'Action failed' });
    expect(log.error).toHaveBeenCalledWith('Cost centre action failed', expect.anything(), 'accounting-api');
  });
});

describe('cost-centres', () => {
  it('?detail=dimensions lists every centre with parent, FNO and aliases, inactive included unless active=true', async () => {
    await call(costCentres, 'GET', {}, { detail: 'dimensions', cc_type: 'cc2' });
    expect(listDimensionCostCentres).toHaveBeenLastCalledWith('co-1', { ccType: 'cc2', includeInactive: true });
    await call(costCentres, 'GET', {}, { detail: 'dimensions', active: 'true', cc_type: 'bogus' });
    expect(listDimensionCostCentres).toHaveBeenLastCalledWith('co-1', { ccType: undefined, includeInactive: false });
  });

  it('a create refusal is a 400 with its message', async () => {
    vi.mocked(planCreateDimensionCostCentre).mockRejectedValueOnce(new DimensionRefusal('A cost centre with code FT001 already exists'));
    const r = await call(costCentres, 'POST', { code: 'ft001', name: 'x', ccType: 'cc1' });
    expect(r).toMatchObject({ status: 400, message: 'A cost centre with code FT001 already exists' });
  });
});

describe('business-units-action', () => {
  it('update: absent stays absent, \'\' clears division and description', async () => {
    await call(businessUnitsAction, 'POST', { action: 'update', id: 'bu-1', name: 'Ops', division: '', description: 7 });
    expect(planUpdateBusinessUnit).toHaveBeenCalledWith('co-1', 'bu-1',
      { code: undefined, name: 'Ops', description: undefined, division: '' });
  });

  it('toggle goes through the plan (defaults, clash) and a toggle to the current state is a 200', async () => {
    const r = await call(businessUnitsAction, 'POST', { action: 'toggle', id: 'bu-1', isActive: false });
    expect(r.status).toBe(200);
    expect(planUpdateBusinessUnit).toHaveBeenCalledWith('co-1', 'bu-1', { isActive: false });
    expect(applyUpdateBusinessUnit).toHaveBeenCalled();
  });

  it('a refusal is a 400 with its message, logged as a warning; delete goes to the counted service', async () => {
    vi.mocked(deleteBusinessUnit).mockRejectedValueOnce(new BusinessUnitActionError('Cannot delete business unit that is used by 3 journal line(s). Deactivate instead.'));
    const r = await call(businessUnitsAction, 'POST', { action: 'delete', id: 'bu-1' });
    expect(r).toMatchObject({ status: 400, message: 'Cannot delete business unit that is used by 3 journal line(s). Deactivate instead.' });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('business-units', () => {
  it('passes the form to the service, which checks lengths and the duplicate code; its refusal is a 400', async () => {
    vi.mocked(createBusinessUnit).mockRejectedValueOnce(new BusinessUnitActionError('A business unit with code OPS already exists'));
    const r = await call(businessUnits, 'POST', { code: ' ops ', name: 'Ops', division: 'Build', description: 5 });
    expect(createBusinessUnit).toHaveBeenCalledWith('co-1', { code: ' ops ', name: 'Ops', description: undefined, division: 'Build' });
    expect(r).toMatchObject({ status: 400, message: 'A business unit with code OPS already exists' });
  });

  it('refuses a body without code or name before the service', async () => {
    const r = await call(businessUnits, 'POST', { name: 'Ops' });
    expect(r.status).toBe(400);
    expect(createBusinessUnit).not.toHaveBeenCalled();
  });
});
