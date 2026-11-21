/**
 * moveIntercompanySide answers only the intercompany sides guard's own refusals (its SQLSTATE AND its message) as a
 * refusal text, logging the original; any other error, a look-alike SQLSTATE included, is rethrown.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: mocks.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));

import { SIDE_GUARD_ERRORS, SIDE_GUARD_REFUSAL, moveIntercompanySide } from '@/modules/accounting/services/core/supplierMergeOpenWork';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const move = () => moveIntercompanySide('co', 'src', 'dst');

describe('moveIntercompanySide', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(SIDE_GUARD_ERRORS.map((g) => [g.code, g.message]))('answers the guard\'s %s "%s" as a refusal and logs the original error', async (code, message) => {
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

describe('the guard table cannot drift from migration 1002', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.intercompany_sides_guard()');
  const body = sql.slice(start, sql.indexOf('$$;', sql.indexOf('AS $$', start) + 5));
  // RAISE EXCEPTION '<message, '' for one quote>' USING ERRCODE = '<state>'
  const raised = [...body.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'\s+USING ERRCODE = '(\w+)'/g)]
    .map((m) => ({ code: m[2]!, message: m[1]!.replace(/''/g, "'") }));

  it('finds the guard and every one of its RAISEs', () => {
    expect(start).toBeGreaterThan(0);
    expect(body.match(/RAISE EXCEPTION/g)?.length).toBe(raised.length);
    expect(raised.length).toBeGreaterThanOrEqual(12);
  });

  it('lists exactly the messages and SQLSTATEs the guard raises', () => {
    const key = (e: { code: string; message: string }) => `${e.code} ${e.message}`;
    expect(SIDE_GUARD_ERRORS.map(key).sort()).toEqual(raised.map(key).sort());
  });
});
