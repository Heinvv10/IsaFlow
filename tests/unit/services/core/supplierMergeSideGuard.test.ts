/**
 * moveIntercompanySide answers only the intercompany sides guard's own refusals (its SQLSTATE AND its message) as a
 * refusal text, logging the original; any other error, a look-alike SQLSTATE included, is rethrown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: mocks.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));

import { SIDE_GUARD_REFUSAL, moveIntercompanySide } from '@/modules/accounting/services/core/supplierMergeOpenWork';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const move = () => moveIntercompanySide('co', 'src', 'dst');

describe('moveIntercompanySide', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['23514', "a revoked connection's sides cannot change"],
    ['42501', 'a side is changed by a user with a write role in its company'],
    ['23503', "the supplier is not this company's"],
  ])('answers the guard\'s %s "%s" as a refusal and logs the original error', async (code, message) => {
    mocks.sql.mockRejectedValueOnce(pgError(code, message));
    await expect(move()).resolves.toEqual({ moved: 0, refusal: SIDE_GUARD_REFUSAL });
    expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code, error: message }), 'duplicate-merge');
  });

  it.each([
    ['23505', 'duplicate key value violates unique constraint "intercompany_sides_supplier_uq"'],
    ['23514', 'new row for relation "x" violates check constraint "y"'],
    ['40P01', 'deadlock detected'],
    ['42501', 'permission denied for table intercompany_connection_sides'],
  ])('rethrows %s "%s" (not the guard)', async (code, message) => {
    mocks.sql.mockRejectedValueOnce(pgError(code, message));
    await expect(move()).rejects.toThrow(message);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('reports the rows it moved', async () => {
    mocks.sql.mockResolvedValueOnce([{ id: 'a' }]);
    await expect(move()).resolves.toEqual({ moved: 1, refusal: null });
  });
});
