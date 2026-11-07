/**
 * Master plan wave 4, PR PV, review round 1: POST /api/accounting/invoice-pdf-preview's own wiring.
 *
 * - The rate-limit bucket is each member's own within the company (`invoice-pdf-preview:u:<userId>`, stored by
 *   checkReportRateLimit as `report:invoice-pdf-preview:u:<userId>:co:<companyId>`), at 300 per 15 min: the 3 s
 *   refetch's ceiling. One member's typing cannot lock a colleague out, and it is not invoice-pdf's bucket.
 * - One charge per request; a refused body costs none.
 * - The body parser stops at 64 KB, and a body nested too deep to measure is a 400 before any charge.
 * - The totals cap is a 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  check: vi.fn(async () => true), build: vi.fn(), pdf: vi.fn(async () => Buffer.from('%PDF')),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: m.check, INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 } }));
vi.mock('@/modules/accounting/services/ar/invoicePdfService', () => ({ generateInvoicePdf: m.pdf }));
vi.mock('@/modules/accounting/services/ar/invoicePreviewModel', () => ({ buildInvoicePreviewModel: m.build }));

import handler, { config } from '../../../pages/api/accounting/invoice-pdf-preview';
import { InvoiceLineValidationError } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { PREVIEW_RATE_LIMIT, previewRateLimitName } from '@/modules/accounting/services/ar/invoicePreviewBody';

const CO = '00000000-0000-4000-8000-0000000000c0';
const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const ANN = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b2';
const BODY = { clientId: CLIENT, items: [{ description: 'x', quantity: 1, unitPrice: 10 }] };

function call(body: unknown, userId = ANN) {
  const state: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    setHeader: vi.fn(),
    status(code: number) { state.status = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    send(b: unknown) { state.body = b; return res; },
    end() { return res; },
  };
  return Promise.resolve(handler({ method: 'POST', body, companyId: CO, user: { id: userId } } as never, res as never))
    .then(() => state);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.check.mockResolvedValue(true);
  m.build.mockResolvedValue({ model: {}, notes: [] });
});

describe('the preview\'s rate-limit bucket', () => {
  it('is each member\'s own, 300 per 15 min, and not invoice-pdf\'s', () => {
    expect(previewRateLimitName(ANN)).toBe(`invoice-pdf-preview:u:${ANN}`);
    expect(PREVIEW_RATE_LIMIT).toEqual({ max: 300, windowSecs: 900 });
  });

  it('charges the caller\'s bucket once per request: two members, two buckets', async () => {
    expect((await call(BODY, ANN)).status).toBe(200);
    expect((await call(BODY, BOB)).status).toBe(200);
    expect(m.check.mock.calls).toEqual([
      [CO, `invoice-pdf-preview:u:${ANN}`, { max: 300, windowSecs: 900 }],
      [CO, `invoice-pdf-preview:u:${BOB}`, { max: 300, windowSecs: 900 }],
    ]);
  });

  it('a full bucket is a 429 and renders nothing', async () => {
    m.check.mockResolvedValueOnce(false);
    expect((await call(BODY)).status).toBe(429);
    expect(m.build).not.toHaveBeenCalled();
    expect(m.pdf).not.toHaveBeenCalled();
  });
});

describe('the body', () => {
  it('the parser stops at 64 KB', () => {
    expect(config.api.bodyParser.sizeLimit).toBe('64kb');
  });

  it('nested too deep to measure: a 400, with no charge', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const res = await call({ ...BODY, deep });
    expect(res.status).toBe(400);
    expect(m.check).not.toHaveBeenCalled();
  });

  it('the totals cap is a 400 with create\'s sentence', async () => {
    m.build.mockRejectedValueOnce(new InvoiceLineValidationError('The invoice total is too large'));
    const res = await call(BODY);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('The invoice total is too large');
  });
});
