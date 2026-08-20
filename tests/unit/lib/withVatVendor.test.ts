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
    await withVatVendor(handler)({ companyId: COMPANY } as never, res);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses with 403 and never reaches the handler for a non-vendor', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'none', vat_system_type: 'none' }]);
    const handler = vi.fn();
    const { res, captured } = makeRes();
    await withVatVendor(handler)({ companyId: COMPANY } as never, res);
    expect(handler).not.toHaveBeenCalled();
    expect(captured.code).toBe(403);
    expect(JSON.stringify(captured.payload)).toContain('not registered for VAT');
  });

  it('scopes its lookup to the authenticated company', async () => {
    sqlMock.mockResolvedValue([{ vat_period: 'bi-monthly', vat_system_type: 'invoice' }]);
    await withVatVendor(vi.fn())({ companyId: COMPANY } as never, makeRes().res);
    expect(JSON.stringify(sqlMock.mock.calls[0])).toContain(COMPANY);
  });
});
