/**
 * PUT /api/accounting/company-settings?type=document-numbers must refuse a
 * retired document type BEFORE it writes anything.
 *
 * `withAuth` COMMITs the request transaction on a 4xx and ROLLBACKs only on a
 * 5xx, so a refusal raised halfway through the update loop would persist the
 * updates already applied — the batch would land partly written and be reported
 * as a 400. The whole batch is therefore validated up front.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  getDocumentNumbers: vi.fn().mockResolvedValue([]),
  ensureDocumentNumbers: vi.fn().mockResolvedValue([]),
  updateDocumentNumber: vi.fn().mockResolvedValue(undefined),
  isRetiredDocumentNumberType: (t: string) => t === 'recurring_invoice',
  getCompanyMessages: vi.fn().mockResolvedValue([]),
  upsertCompanyMessages: vi.fn().mockResolvedValue(undefined),
}));

import { updateDocumentNumber } from '@/modules/accounting/services/core/companyService';
import handler from '../../../pages/api/accounting/company-settings';

const mockUpdate = updateDocumentNumber as unknown as ReturnType<typeof vi.fn>;

function makeRes() {
  const res = { statusCode: 200 } as unknown as NextApiResponse & { body?: unknown };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { (res as { body?: unknown }).body = b; return res; }) as never;
  return res;
}

const put = (updates: unknown[]) => ({
  method: 'PUT',
  query: { type: 'document-numbers' },
  companyId: 'c1',
  body: { updates },
} as unknown as NextApiRequest);

describe('company-settings document-numbers PUT', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a retired type and writes nothing', async () => {
    const res = makeRes();
    await handler(put([{ documentType: 'recurring_invoice', prefix: 'RINV', nextNumber: 900 }]) as never, res as never);
    expect.soft(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE batch when a retired type is mixed in with live ones', async () => {
    // The live update sits FIRST: a per-iteration check would have written it
    // and then answered 400, and withAuth would have committed that write.
    const res = makeRes();
    await handler(put([
      { documentType: 'customer_invoice', prefix: 'INV', nextNumber: 500 },
      { documentType: 'recurring_invoice', prefix: 'RINV', nextNumber: 900 },
    ]) as never, res as never);
    expect.soft(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('applies a batch of live types normally', async () => {
    const res = makeRes();
    await handler(put([
      { documentType: 'customer_invoice', prefix: 'INV', nextNumber: 500 },
      { documentType: 'supplier_invoice', prefix: 'SIV' },
    ]) as never, res as never);
    expect.soft(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});
