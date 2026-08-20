/**
 * Server-side gate on the VAT-only API routes. The UI hides these surfaces,
 * but a direct call would otherwise still generate and persist VAT201 drafts,
 * adjustments and DRC postings for a company that does not file VAT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...args: unknown[]) => sqlMock(...args) }));

const { withVatVendor, isCompanyVatVendor } = await import('@/lib/auth/withVatVendor');

/** Minimal NextApiResponse stand-in — apiResponse only needs status().json(). */
function makeRes() {
  const captured: { code?: number; payload?: unknown } = {};
  const res = {
    status(code: number) { captured.code = code; return res; },
    json(payload: unknown) { captured.payload = payload; return res; },
    setHeader() { return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  return { res, captured };
}

const COMPANY = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => { sqlMock.mockReset(); });

describe('isCompanyVatVendor', () => {
  it('is true for a registered vendor', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'bi-monthly', vat_system_type: 'invoice' }]);
    expect(await isCompanyVatVendor(COMPANY)).toBe(true);
  });

  it('is false when either column says none', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'none', vat_system_type: 'invoice' }]);
    expect(await isCompanyVatVendor(COMPANY)).toBe(false);
    sqlMock.mockResolvedValue([{ vat_period: 'bi-monthly', vat_system_type: 'none' }]);
    expect(await isCompanyVatVendor(COMPANY)).toBe(false);
  });

  it('is false for an unknown company rather than defaulting open', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await isCompanyVatVendor(COMPANY)).toBe(false);
  });
});

describe('withVatVendor', () => {
  it('runs the handler for a VAT vendor', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'monthly', vat_system_type: 'invoice' }]);
    const handler = vi.fn();
    const { res } = makeRes();
    await withVatVendor(handler)({ companyId: COMPANY, method: 'POST' } as never, res);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses a write with 403 and never reaches the handler for a non-vendor', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'none', vat_system_type: 'none' }]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const handler = vi.fn();
      const { res, captured } = makeRes();
      await withVatVendor(handler)({ companyId: COMPANY, method } as never, res);
      expect(handler, method).not.toHaveBeenCalled();
      expect(captured.code, method).toBe(403);
      expect(JSON.stringify(captured.payload)).toContain('not registered for VAT');
    }
  });

  it('still serves READS to a company that has deregistered', async () => {
    // SARS requires five years of records: a company that stops being a VAT
    // vendor must keep access to the returns it filed while it was one.
    sqlMock.mockResolvedValue([{ vat_period: 'none', vat_system_type: 'none' }]);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const handler = vi.fn();
      const { res, captured } = makeRes();
      await withVatVendor(handler)({ companyId: COMPANY, method } as never, res);
      expect(handler, method).toHaveBeenCalledOnce();
      expect(captured.code, method).toBeUndefined();
    }
  });

  it('does not even query the database on a read', async () => {
    const handler = vi.fn();
    await withVatVendor(handler)({ companyId: COMPANY, method: 'GET' } as never, makeRes().res);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('scopes its lookup to the authenticated company', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'bi-monthly', vat_system_type: 'invoice' }]);
    await withVatVendor(vi.fn())({ companyId: COMPANY, method: 'POST' } as never, makeRes().res);
    expect(JSON.stringify(sqlMock.mock.calls[0])).toContain(COMPANY);
  });
});
