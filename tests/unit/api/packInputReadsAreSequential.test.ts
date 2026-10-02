/**
 * ONE CONNECTION, ONE READ AT A TIME.
 *
 * Under `withAuth` a request has one pg client and one transaction.
 * `getReportPackInput` takes a savepoint around its cash-flow read so that a
 * failed statement can be rolled back and the pack degrade. Both of these
 * routes ran it inside a `Promise.all` beside another read: the sibling's
 * queries then land between `SAVEPOINT pack_cash_flows` and its release or
 * rollback, and a failed cash-flow statement leaves the SIBLING's next query
 * refused with 25P02 — a 500 where the pack was built to degrade.
 *
 * Asserted as what it is: the second read does not start until the first has
 * settled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getReportPackInputMock = vi.fn();
const getPackTrendMock = vi.fn();
const getCompanyDetailsMock = vi.fn();

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ name: 'Acme Fibre (Pty) Ltd' }]) }));
vi.mock('@/modules/accounting/services/reports/reportPackDataService', () => ({
  getReportPackInput: (...a: unknown[]) => getReportPackInputMock(...a),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({
  getPackTrend: (...a: unknown[]) => getPackTrendMock(...a),
}));
vi.mock('@/modules/accounting/services/core/pdfShared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCompanyDetailsFromCompany: (...a: unknown[]) => getCompanyDetailsMock(...a),
}));

import pptxRoute from '../../../pages/api/accounting/packs/[id]/pptx';
import reportsPdfRoute from '../../../pages/api/accounting/reports-pdf';

/** A read that stays in flight until the test lets it go. */
function inFlight<T>(): { promise: Promise<T>; fail: (e: Error) => void } {
  let fail!: (e: Error) => void;
  const promise = new Promise<T>((_resolve, reject) => { fail = reject; });
  return { promise, fail };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const STOP = new Error('stop the handler here');

function res(): NextApiResponse {
  const r = {
    status() { return r; }, json() { return r; }, end() { return r; }, send() { return r; },
    setHeader() { return r; },
  };
  return r as unknown as NextApiResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  getPackTrendMock.mockResolvedValue([]);
  getCompanyDetailsMock.mockResolvedValue({ name: 'Acme Fibre (Pty) Ltd' });
});

describe('GET /api/accounting/packs/[id]/pptx', () => {
  it('does not start the trend read while the pack input is still being read', async () => {
    const input = inFlight<never>();
    getReportPackInputMock.mockReturnValue(input.promise);

    const request = pptxRoute({
      method: 'GET', query: { id: 'management', from: '2026-01-01', to: '2026-09-05' },
      companyId: 'c1', user: { id: 'u1' },
    } as unknown as NextApiRequest, res());
    await settle();

    expect(getReportPackInputMock).toHaveBeenCalledTimes(1);
    expect(getPackTrendMock, 'the trend read started beside the pack input').not.toHaveBeenCalled();

    input.fail(STOP);
    await expect(request).rejects.toBe(STOP);
  });
});

describe('POST /api/accounting/reports-pdf', () => {
  it('does not read the pack input while the company details are still being read', async () => {
    const company = inFlight<never>();
    getCompanyDetailsMock.mockReturnValue(company.promise);
    getReportPackInputMock.mockRejectedValue(STOP);

    const request = reportsPdfRoute({
      method: 'POST', body: { type: 'management', from: '2026-01-01', to: '2026-09-05' },
      companyId: 'c1', user: { id: 'u1' },
    } as unknown as NextApiRequest, res());
    await settle();

    expect(getCompanyDetailsMock).toHaveBeenCalledTimes(1);
    expect(getReportPackInputMock, 'the pack input was read beside the company details').not.toHaveBeenCalled();

    company.fail(STOP);
    await expect(request).rejects.toBe(STOP);
  });
});
