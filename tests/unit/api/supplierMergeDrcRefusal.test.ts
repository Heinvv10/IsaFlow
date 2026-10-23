/**
 * Both supplier-merge routes turn a SupplierMergeRefusal (raised before
 * anything moves) into a 400 carrying its message. duplicates-merge used to
 * send every error to a 500, which would have hidden the reason and the fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({
  mergeEntities: vi.fn(),
  assertFlag: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: mocks.withTransaction }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: unknown) => handler,
  withWriteAccess: (handler: unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (handler: unknown) => handler }));
vi.mock('@/modules/accounting/services/core/duplicateDetectionService', () => ({ mergeEntities: mocks.mergeEntities }));
vi.mock('@/modules/accounting/services/core/duplicateMergeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/core/duplicateMergeService')>();
  return { ...actual, assertSupplierMergeKeepsDrcFlag: mocks.assertFlag };
});

import duplicatesMerge from '../../../pages/api/accounting/duplicates-merge';
import supplierMerge from '../../../pages/api/accounting/supplier-merge';
import { SupplierMergeRefusal } from '@/modules/accounting/services/core/duplicateMergeService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const REFUSAL = 'Flagged is marked "Subject to DRC VAT" and Plain is not.';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const post = (body: Record<string, unknown>) =>
  ({ method: 'POST', companyId: COMPANY, companyRole: 'admin', user: { id: 'u' }, query: {}, body }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const text = (res: NextApiResponse) => JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]);

describe('supplier merge routes — DRC flag refusal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('duplicates-merge answers 400 with the refusal message', async () => {
    mocks.mergeEntities.mockRejectedValueOnce(new SupplierMergeRefusal(REFUSAL));
    const res = response();
    await duplicatesMerge(post({ entityType: 'supplier', primaryId: A, duplicateId: B }), res);
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('Subject to DRC VAT');
  });

  it('supplier-merge checks before its transaction, answers 400, and moves nothing', async () => {
    mocks.assertFlag.mockRejectedValueOnce(new SupplierMergeRefusal(REFUSAL));
    const res = response();
    await supplierMerge(post({ source_id: A, target_id: B }), res);
    expect(mocks.assertFlag).toHaveBeenCalledWith(COMPANY, A, B, A); // A is the source, the supplier merged away
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(status(res)).toBe(400);
    expect(text(res)).toContain('Subject to DRC VAT');
  });

  it('supplier-merge proceeds to the transaction when the flags agree', async () => {
    mocks.assertFlag.mockResolvedValueOnce(undefined);
    mocks.withTransaction.mockResolvedValueOnce(undefined);
    const res = response();
    await supplierMerge(post({ source_id: A, target_id: B }), res);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(status(res)).toBe(200);
  });
});
