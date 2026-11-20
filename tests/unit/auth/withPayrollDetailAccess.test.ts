/**
 * withPayrollDetailAccess: the write roles pass on every method (GET included); anyone else, or no role at all, gets 403
 * before the handler runs. #1656 (Hein, 2026-11-19): and Payroll read in the user's module permissions, read from the
 * database: a former accountant / bookkeeper (a manager now, with nothing on Payroll) and a manager whose Payroll read
 * an owner or admin unticked are refused too.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
let db = permissionDb();
beforeEach(() => { db = permissionDb(); vi.mocked(sql).mockImplementation(permissionSql(db) as never); });

function run(role: string | undefined, method: string, stored = role) {
  if (stored) db.members.set(`${C}:${U}`, stored);
  const handler = vi.fn();
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, setHeader() { return this; } };
  return withPayrollDetailAccess(handler)({ method, companyRole: role, companyId: C, user: { id: U } } as unknown as NextApiRequest, res as unknown as NextApiResponse)
    .then(() => ({ handler, status: res.statusCode }));
}

describe('withPayrollDetailAccess', () => {
  it.each(['owner', 'admin', 'manager'])('%s reaches the handler on GET and POST', async (role) => {
    for (const method of ['GET', 'POST']) expect((await run(role, method)).handler).toHaveBeenCalledOnce();
  });
  it.each([['viewer'], ['accountant'], [undefined]])('%s is refused on GET and the handler never runs', async (role) => {
    const r = await run(role, 'GET');
    expect(r.status).toBe(403);
    expect(r.handler).not.toHaveBeenCalled();
  });
  it.each(['bookkeeper', 'accountant'])('a stored %s (reads as manager) has no Payroll: refused', async (stored) => {
    const r = await run('manager', 'GET', stored);
    expect(r.status).toBe(403);
    expect(r.handler).not.toHaveBeenCalled();
    expect(db.reads).toEqual([{ companyId: C, userId: U, moduleKey: 'payroll' }]);
  });
  it("a manager whose Payroll read is unticked is refused; an owner's unticked row does not count", async () => {
    db.rows.set(`${C}:${U}:payroll`, { can_read: false });
    expect((await run('manager', 'GET')).status).toBe(403);
    expect((await run('owner', 'GET')).handler).toHaveBeenCalledOnce();
  });
});
