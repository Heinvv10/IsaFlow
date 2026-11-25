/**
 * A ChartRefusal is a validation answer ("Subtype is required for a revenue
 * account"), not a fault. Logged at error it reached Bugsink as an issue on
 * every bad form submit. Both log sites (service + POST route) log it at WARN;
 * every other error stays at ERROR. The HTTP/throw behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createAccount, updateAccount, deleteAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { ChartRefusal } from '@/modules/accounting/services/gl/chartRefusal';
import { ParentAccountError } from '@/modules/accounting/services/gl/accountParentRules';
import * as service from '@/modules/accounting/services/gl/chartOfAccountsService';
import handler from '../../../../pages/api/accounting/chart-of-accounts';

const CO = '11111111-1111-4111-8111-111111111111';
const FAILED = 'Failed to create account';

beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockReset(); });

describe('createAccount log level', () => {
  it('logs a ChartRefusal at warn, never error, and still throws it', async () => {
    await expect(createAccount(CO, {
      accountCode: '4999', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit',
    })).rejects.toBeInstanceOf(ChartRefusal);
    expect(log.warn).toHaveBeenCalledWith(FAILED, expect.anything(), 'accounting');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps a generic Error at error, never warn, and still throws it', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    await expect(createAccount(CO, {
      accountCode: '1000', accountName: 'Bank', accountType: 'asset', normalBalance: 'debit',
    })).rejects.toThrow('Connection terminated unexpectedly');
    expect(log.error).toHaveBeenCalledWith(FAILED, expect.anything(), 'accounting');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('createAccount ParentAccountError log level', () => {
  it('logs a ParentAccountError at warn, never error, and still throws it', async () => {
    vi.mocked(sql).mockResolvedValue([] as never); // parent lookup finds nothing
    await expect(createAccount(CO, {
      accountCode: '1500', accountName: 'Child', accountType: 'asset', normalBalance: 'debit',
      accountSubtype: 'other_current_asset', parentAccountId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toBeInstanceOf(ParentAccountError);
    expect(log.warn).toHaveBeenCalledWith(FAILED, expect.anything(), 'accounting');
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('updateAccount / deleteAccount log level', () => {
  const ID = '33333333-3333-4333-8333-333333333333';
  const UPD = 'Failed to update account';
  const DEL = 'Failed to delete account';

  it('update: ChartRefusal logs at warn, never error, and still throws', async () => {
    vi.mocked(sql).mockResolvedValue([] as never); // account not found => ChartRefusal
    await expect(updateAccount(CO, ID, { accountName: 'x' })).rejects.toBeInstanceOf(ChartRefusal);
    expect(log.warn).toHaveBeenCalledWith(UPD, expect.anything(), 'accounting');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('update: generic Error logs at error, never warn, and still throws', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await expect(updateAccount(CO, ID, { accountName: 'x' })).rejects.toThrow('Connection terminated');
    expect(log.error).toHaveBeenCalledWith(UPD, expect.anything(), 'accounting');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('delete: ChartRefusal logs at warn, never error, and still throws', async () => {
    vi.mocked(sql).mockResolvedValue([{ cnt: '2' }] as never); // active children => ChartRefusal
    await expect(deleteAccount(CO, ID)).rejects.toBeInstanceOf(ChartRefusal);
    expect(log.warn).toHaveBeenCalledWith(DEL, expect.anything(), 'accounting');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('delete: generic Error logs at error, never warn, and still throws', async () => {
    vi.mocked(sql).mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await expect(deleteAccount(CO, ID)).rejects.toThrow('Connection terminated');
    expect(log.error).toHaveBeenCalledWith(DEL, expect.anything(), 'accounting');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/chart-of-accounts log level', () => {
  const body = { accountCode: '4999', accountName: 'Sales', accountType: 'revenue', normalBalance: 'credit' };
  function mockReqRes() {
    const req = { method: 'POST', query: {}, body, companyId: 'co-1' } as unknown as NextApiRequest;
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

  it('logs a ChartRefusal at warn, never error, and still answers 400', async () => {
    vi.spyOn(service, 'createAccount').mockRejectedValueOnce(new ChartRefusal('Subtype is required for a revenue account'));
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('Subtype is required');
    expect(log.warn).toHaveBeenCalledWith(FAILED, expect.anything(), 'accounting-api');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps a generic Error at error, never warn, and still propagates it', async () => {
    vi.spyOn(service, 'createAccount').mockRejectedValueOnce(new Error('boom'));
    const { req, res } = mockReqRes();
    await expect(handler(req, res)).rejects.toThrow('boom');
    expect(log.error).toHaveBeenCalledWith(FAILED, expect.anything(), 'accounting-api');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('POST ParentAccountError and PUT log level (route)', () => {
  const MSG = 'Parent account zz-route-only-text not found';
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
  const post = { accountCode: '1500', accountName: 'Child', accountType: 'asset', normalBalance: 'debit' };
  const put = { id: '33333333-3333-4333-8333-333333333333', accountName: 'Renamed' };

  it('POST: ParentAccountError logs at warn, never error, and still answers 400', async () => {
    const spy = vi.spyOn(service, 'createAccount').mockRejectedValueOnce(new ParentAccountError(MSG));
    const { req, res } = mockReqRes('POST', post);
    await handler(req, res);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('zz-route-only-text');
    expect(log.warn).toHaveBeenCalledWith('Failed to create account', expect.anything(), 'accounting-api');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('PUT: ChartRefusal logs at warn, never error, and still answers 400', async () => {
    const spy = vi.spyOn(service, 'updateAccount').mockRejectedValueOnce(new ChartRefusal('zz-route-only-refusal'));
    const { req, res } = mockReqRes('PUT', put);
    await handler(req, res);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('zz-route-only-refusal');
    expect(log.warn).toHaveBeenCalledWith('Failed to update account', expect.anything(), 'accounting-api');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('PUT: generic Error logs at error, never warn, and still propagates', async () => {
    vi.spyOn(service, 'updateAccount').mockRejectedValueOnce(new Error('boom'));
    const { req, res } = mockReqRes('PUT', put);
    await expect(handler(req, res)).rejects.toThrow('boom');
    expect(log.error).toHaveBeenCalledWith('Failed to update account', expect.anything(), 'accounting-api');
    expect(log.warn).not.toHaveBeenCalled();
  });
});
