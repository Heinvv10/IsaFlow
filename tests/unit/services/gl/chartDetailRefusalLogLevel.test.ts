/**
 * chart-of-accounts-detail: a ChartRefusal in the PUT / PATCH / DELETE catches is
 * a validation answer, not a fault, so it logs at WARN (keeps it out of Bugsink).
 * Every other error stays at ERROR. HTTP answers and throws are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import { log } from '@/lib/logger';
import { ChartRefusal } from '@/modules/accounting/services/gl/chartRefusal';
import * as service from '@/modules/accounting/services/gl/chartOfAccountsService';
import handler from '../../../../pages/api/accounting/chart-of-accounts-detail';

const ID = '33333333-3333-4333-8333-333333333333';
const COMPONENT = 'accounting-api';

beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function mockReqRes(method: string, body: unknown) {
  const req = { method, query: {}, body, companyId: 'co-1', companyRole: 'owner', user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const cases = [
  { name: 'PUT update', method: 'PUT', fn: 'updateAccount', msg: 'Failed to update account', body: { id: ID, accountName: 'Renamed' } },
  { name: 'PATCH rename', method: 'PATCH', fn: 'renameAccountCode', msg: 'Failed to rename account code', body: { id: ID, accountCode: '4100' } },
  { name: 'DELETE', method: 'DELETE', fn: 'deleteAccount', msg: 'Failed to delete account', body: { id: ID } },
] as const;

describe.each(cases)('$name catch log level', ({ method, fn, msg, body }) => {
  it('ChartRefusal logs at warn, never error, and still answers 400', async () => {
    const spy = vi.spyOn(service, fn).mockRejectedValueOnce(new ChartRefusal('zz-detail-refusal-text'));
    const { req, res } = mockReqRes(method, body);
    await handler(req, res);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('zz-detail-refusal-text');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(msg, expect.objectContaining({ id: ID, error: expect.any(ChartRefusal) }), COMPONENT);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('generic Error logs at error, never warn, and still propagates', async () => {
    const spy = vi.spyOn(service, fn).mockRejectedValueOnce(new Error('boom'));
    const { req, res } = mockReqRes(method, body);
    await expect(handler(req, res)).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(msg, expect.objectContaining({ id: ID }), COMPONENT);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
