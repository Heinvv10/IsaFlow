/**
 * W1-02 (PUR-08): GET /api/accounting/document-capture?id= returns one
 * document, scoped to the caller's company. The sql fake honours the WHERE
 * clause it is given: rows are only filtered by company when the query text
 * mentions company_id, so dropping the predicate from the handler leaks.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const CO_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CO_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const store = [{
  id: DOC_A, company_id: CO_A, file_name: 'a.png', file_type: 'png', file_size: 1, document_type: 'receipt',
  extracted_data: null, vendor_name: 'Shell', document_date: null, reference_number: null,
  total_amount: '100', vat_amount: '15', status: 'pending', matched_invoice_id: null,
  matched_bank_tx_id: null, notes: null, uploaded_by: null, created_at: '2026-04-25T00:00:00Z',
}];

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    return store.filter((r) => values.includes(r.id) && (!text.includes('company_id') || values.includes(r.company_id)));
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/ocrService', () => ({ extractFromPdf: vi.fn(), extractFromImage: vi.fn() }));

import handler from '../../../pages/api/accounting/document-capture';

function call(companyId: string, query: Record<string, string>) {
  const req = { method: 'GET', query, companyId } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
  };
  return (handler as unknown as (a: NextApiRequest, b: unknown) => Promise<void>)(req, res).then(() => res);
}

describe('GET /api/accounting/document-capture?id=', () => {
  it('returns the document to its own company', async () => {
    const res = await call(CO_A, { id: DOC_A });
    expect(res.statusCode).toBe(200);
    expect((res.sent as { data: { id: string; vendorName: string } }).data).toMatchObject({ id: DOC_A, vendorName: 'Shell' });
  });

  it("404s another company's document id", async () => {
    const res = await call(CO_B, { id: DOC_A });
    expect(res.statusCode).toBe(404);
  });

  it('400s a non-UUID id', async () => {
    const res = await call(CO_A, { id: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});
