/** withPayrollDetailAccess: the write roles pass on every method (GET included); anyone else, or no role at all, gets 403 before the handler runs. */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';

function run(role: string | undefined, method: string) {
  const handler = vi.fn();
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, setHeader() { return this; } };
  return withPayrollDetailAccess(handler)({ method, companyRole: role } as unknown as NextApiRequest, res as unknown as NextApiResponse)
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
});
