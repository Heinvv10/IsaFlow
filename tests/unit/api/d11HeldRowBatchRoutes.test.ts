/**
 * D11 round 3 (brk-d11 G3): a batch route that attempted items and found EVERY one held answers 503 + Retry-After
 * (nothing committed) instead of a 200 whose body says "retry". Mixed results keep the 200 with per-item outcomes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ txUnusable: false }) }, assertTxUsable: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/ar/recurringInvoiceService', () => ({ generateInvoiceFromRecurring: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', async (orig) => ({ ...(await orig<object>()), approveSupplierInvoice: vi.fn(), cancelSupplierInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', async (orig) => ({ ...(await orig<object>()), postSupplierInvoiceToGL: vi.fn() }));

import { sql } from '@/lib/neon';
import { generateInvoiceFromRecurring } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { CustomerInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/customerInvoiceLock';
import recurringRun from '../../../pages/api/accounting/recurring-invoices-run';
import bulk from '../../../pages/api/accounting/supplier-invoices-bulk-action';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
function call(handler: Handler, body: unknown) {
  const req = { method: 'POST', query: {}, body, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const heldErr = () => new CustomerInvoiceLockTimeoutError('Invoice');
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const held = (r: Awaited<ReturnType<typeof call>>) => { expect(r.statusCode, JSON.stringify(r.sent)).toBe(503); expect(r.headers['Retry-After']).toBe('2'); };

beforeEach(() => { vi.clearAllMocks(); });

describe('recurring-invoices-run', () => {
  it('a single id that is held -> 503 + Retry-After', async () => {
    vi.mocked(generateInvoiceFromRecurring).mockRejectedValueOnce(heldErr());
    held(await call(recurringRun, { recurring_invoice_id: A }));
  });
  it.each(['40P01', '55P03'])('a single id held as a raw %s answers 503 WITHOUT the driver text', async (code) => {
    vi.mocked(generateInvoiceFromRecurring).mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected: relation "recurring_invoices" key (id)=(x)'), { code }));
    const r = await call(recurringRun, { recurring_invoice_id: A });
    held(r);
    expect(JSON.stringify(r.sent)).not.toMatch(/deadlock|recurring_invoices|relation|key \(id\)/);
    expect(JSON.stringify(r.sent)).toMatch(/retry in a moment/);
  });
  it('a single id that fails ordinarily keeps 200 with the error in the body', async () => {
    vi.mocked(generateInvoiceFromRecurring).mockRejectedValueOnce(new Error('bad template'));
    const r = await call(recurringRun, { recurring_invoice_id: A });
    expect(r.statusCode).toBe(200); expect(r.headers['Retry-After']).toBeUndefined();
  });
  it('every due template held -> 503', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: A }, { id: B }] as never);
    vi.mocked(generateInvoiceFromRecurring).mockRejectedValueOnce(heldErr()).mockRejectedValueOnce(deadlock());
    held(await call(recurringRun, {}));
  });
  it('mixed (one generated, one held) keeps 200 with per-item results', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: A }, { id: B }] as never);
    vi.mocked(generateInvoiceFromRecurring).mockResolvedValueOnce('inv').mockRejectedValueOnce(heldErr());
    const r = await call(recurringRun, {});
    expect(r.statusCode).toBe(200); expect(r.headers['Retry-After']).toBeUndefined();
    expect(r.sent).toMatchObject({ data: { generated: 1 } });
  });
});

describe('mixed batches show NEUTRAL text for a raw held-row item, ok items unchanged', () => {
  const raw = () => Object.assign(new Error('deadlock detected: relation "supplier_invoices" key (id)=(x)'), { code: '40P01' });
  const clean = (r: Awaited<ReturnType<typeof call>>) => expect(JSON.stringify(r.sent)).not.toMatch(/deadlock|supplier_invoices|key \(id\)/);
  it('recurring-invoices-run', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: A }, { id: B }] as never);
    vi.mocked(generateInvoiceFromRecurring).mockResolvedValueOnce('inv').mockRejectedValueOnce(raw());
    const r = await call(recurringRun, {});
    expect(r.statusCode).toBe(200); clean(r);
    expect(r.sent).toMatchObject({ data: { generated: 1, invoice_ids: ['inv'] } });
    expect(JSON.stringify(r.sent)).toMatch(/retry in a moment/);
  });
  it('supplier-invoices-bulk-action', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(raw());
    const r = await call(bulk, { action: 'post_gl', invoiceIds: [A, B] });
    expect(r.statusCode).toBe(200); clean(r);
    expect(r.sent).toMatchObject({ data: { succeeded: 1, failed: 1 } });
    expect(JSON.stringify(r.sent)).toMatch(/retry in a moment/);
  });
  it('an ordinary item failure keeps its own text', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('not approved'));
    expect(JSON.stringify((await call(bulk, { action: 'post_gl', invoiceIds: [A, B] })).sent)).toMatch(/not approved/);
  });
});

describe('supplier-invoices-bulk-action', () => {
  it('a single held id -> 503 + Retry-After', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockRejectedValueOnce(heldErr());
    held(await call(bulk, { action: 'post_gl', invoiceIds: [A] }));
  });
  it('all ids held (typed and deadlock) -> 503', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockRejectedValueOnce(heldErr()).mockRejectedValueOnce(deadlock());
    held(await call(bulk, { action: 'post_gl', invoiceIds: [A, B] }));
  });
  it('mixed (one ok, one held) keeps 200 per-item', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(heldErr());
    const r = await call(bulk, { action: 'post_gl', invoiceIds: [A, B] });
    expect(r.statusCode).toBe(200); expect(r.headers['Retry-After']).toBeUndefined();
    expect(r.sent).toMatchObject({ data: { succeeded: 1, failed: 1 } });
  });
  it('an ordinary failure on every id keeps 200', async () => {
    vi.mocked(postSupplierInvoiceToGL).mockRejectedValueOnce(new Error('not approved'));
    const r = await call(bulk, { action: 'post_gl', invoiceIds: [A] });
    expect(r.statusCode).toBe(200);
  });
});
