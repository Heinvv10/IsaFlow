/**
 * POPIA (Hein, 2026-11-05): invoice view receipts keep the viewer's IP address and browser for 12 months, then go. One
 * global retention DELETE on the receipt's own timestamp (customer_invoice_views.viewed_at), run daily by a cron route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import { purgeInvoiceViewReceipts, INVOICE_VIEW_RETENTION_MONTHS } from '@/modules/accounting/services/ar/invoiceViewRetention';
import cronRoute from '../../../../pages/api/cron/invoice-views-retention';

const text = () => (sqlMock.mock.calls[0]![0] as readonly string[]).join('?').replace(/\s+/g, ' ');

beforeEach(() => { vi.clearAllMocks(); sqlMock.mockResolvedValue([{ n: 7 }]); });

describe('purgeInvoiceViewReceipts', () => {
  it('keeps 12 months', () => { expect(INVOICE_VIEW_RETENTION_MONTHS).toBe(12); });

  it('deletes receipts older than the retention on their own timestamp, and says how many', async () => {
    expect(await purgeInvoiceViewReceipts()).toBe(7);
    expect(text()).toMatch(/DELETE FROM customer_invoice_views WHERE viewed_at < NOW\(\) - \(\?\)::interval/);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['12 months']);
  });

  it('a different retention is a parameter, never spliced into the SQL', async () => {
    await purgeInvoiceViewReceipts(6);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['6 months']);
    await expect(purgeInvoiceViewReceipts(0)).rejects.toThrow(/whole number of months/);
    await expect(purgeInvoiceViewReceipts(1.5)).rejects.toThrow(/whole number of months/);
    await expect(purgeInvoiceViewReceipts(Number.NaN)).rejects.toThrow(/whole number of months/);
  });
});

function res() {
  const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
  return r;
}
async function call(req: Record<string, unknown>) {
  const out = res();
  await (cronRoute as (q: unknown, s: unknown) => Promise<unknown>)({ headers: {}, socket: {}, ...req }, out);
  return out;
}
const KEY = crypto.randomUUID();

describe('POST /api/cron/invoice-views-retention', () => {
  beforeEach(() => { process.env.CRON_SECRET = KEY; });

  it('runs with the right secret and reports the count', async () => {
    const r = await call({ method: 'POST', headers: { 'x-cron-secret': KEY } });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.body)).toContain('"deleted":7');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it.each([[{}], [{ 'x-cron-secret': 'wrong' }], [{ 'x-cron-secret': `${KEY}x` }]])('refuses %j with 401 and deletes nothing', async (headers) => {
    expect((await call({ method: 'POST', headers })).statusCode).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('GET is 405 and an unset CRON_SECRET is 500; neither deletes', async () => {
    expect((await call({ method: 'GET', headers: { 'x-cron-secret': KEY } })).statusCode).toBe(405);
    delete process.env.CRON_SECRET;
    expect((await call({ method: 'POST', headers: { 'x-cron-secret': '' } })).statusCode).toBe(500);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
