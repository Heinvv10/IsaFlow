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
import { createAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { ChartRefusal } from '@/modules/accounting/services/gl/chartRefusal';
import * as service from '@/modules/accounting/services/gl/chartOfAccountsService';
import handler from '../../../../pages/api/accounting/chart-of-accounts';

const CO = '11111111-1111-4111-8111-111111111111';
const FAILED = 'Failed to create account';

beforeEach(() => { vi.clearAllMocks(); });

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
