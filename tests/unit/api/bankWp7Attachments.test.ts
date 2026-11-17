/**
 * WP7: bank-tx-attachments. GET: bankTransactionId must be a UUID (400) and the list is capped (newest N, with
 * X-Attachments-Truncated when older ones exist); POST refuses a line's 21st stored upload (409).
 * The cap itself (the newest N, and the truncated flag) is tested on the service the route calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const sqlMock = vi.fn();
const capped = vi.fn();
const counted = vi.fn();
const locked = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/vlmService', () => ({ isVlmAvailable: () => false }));
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentExtraction', () => ({ extractAttachmentData: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/capturedAttachmentLinks', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/capturedAttachmentLinks')>()),
  listBankLineAttachmentsCapped: (...a: unknown[]) => capped(...a),
  countBankLineAttachments: (...a: unknown[]) => counted(...a),
}));
const settledList = vi.fn();
vi.mock('@/modules/accounting/services/bank/settledDocumentService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/settledDocumentService')>()),
  listSettledDocuments: (...a: unknown[]) => settledList(...a),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({ lockBankTransactionForUpdate: (...a: unknown[]) => locked(...a) }));

import handler from '../../../pages/api/accounting/bank-tx-attachments';
import { BANK_LINE_ATTACHMENT_LIST_MAX } from '@/modules/accounting/services/capture/capturedAttachmentLinks';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SETTLED = {
  source: 'settled_document' as const, documentId: 'd1', store: 'entity' as const, fileName: 'SIV-1.pdf', mimeType: 'application/pdf',
  fileSize: 100, fileUrl: 'https://files.test/SIV-1.pdf', createdAt: '2026-10-20T00:00:00.000Z',
  via: { kind: 'supplier_payment' as const, paymentId: 'p1', paymentNumber: 'SP-1' },
  settles: { entityType: 'supplier_invoice' as const, entityId: 'b1', number: 'SIV-1', total: 1000, applied: 1000, partial: false,
    invoiceId: 'b1', invoiceNumber: 'SIV-1' },
};

beforeEach(() => {
  sqlMock.mockReset().mockResolvedValue([{ id: UUID_A }]); // ownership
  capped.mockReset().mockResolvedValue({ items: [{ id: 'a1' }], truncated: false });
  counted.mockReset().mockResolvedValue(1);
  locked.mockReset().mockResolvedValue({ id: UUID_A });
  settledList.mockReset().mockResolvedValue([SETTLED]);
});

describe('GET', () => {
  it.each(BAD_IDS)('a bankTransactionId of %s is a 400 before any read', async (bad) => {
    expect((await callRoute(handler, { query: { bankTransactionId: bad } })).code).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(capped).not.toHaveBeenCalled();
  });

  it('lists through the capped reader, and flags a cut list in a header', async () => {
    capped.mockResolvedValue({ items: [{ id: 'a1' }], truncated: true });
    counted.mockResolvedValue(137);
    const r = await callRoute(handler, { query: { bankTransactionId: UUID_A } });
    expect(r.code).toBe(200);
    expect(r.headers['X-Attachments-Truncated']).toBe('true');
    expect(r.headers['X-Attachments-Total']).toBe('137'); // the TRUE visible count, for "Showing newest N of M"
    expect(capped).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', UUID_A);
  });

  it('an uncut list carries no truncation header', async () => {
    const r = await callRoute(handler, { query: { bankTransactionId: UUID_A } });
    expect(r.headers['X-Attachments-Truncated']).toBeUndefined();
    expect(r.headers['X-Attachments-Total']).toBe('1'); // an uncut list: its own length, no second count query
    expect(counted).not.toHaveBeenCalled();
  });
});

describe('POST', () => {
  const post = () => callRoute(handler, { method: 'POST', body: { bankTransactionId: UUID_A, fileName: 'slip.png', fileData: PNG } });
  const inserted = () => sqlMock.mock.calls.some(([s]) => (s as string[]).join('?').includes('INSERT INTO bank_transaction_attachments'));

  it('refuses the upload past the per-line cap with a 409 and inserts nothing', async () => {
    counted.mockResolvedValue(BANK_LINE_ATTACHMENT_LIST_MAX);
    const r = await post();
    expect(r.code).toBe(409);
    expect(inserted()).toBe(false);
  });

  it('the cap is 100, counted with the list\'s own visible predicate (countBankLineAttachments), not a raw row count', async () => {
    expect(BANK_LINE_ATTACHMENT_LIST_MAX).toBe(100);
    counted.mockResolvedValue(99);
    sqlMock.mockResolvedValueOnce([{ id: UUID_A }]); // ownership
    sqlMock.mockResolvedValueOnce([{ id: 'new' }]); // INSERT
    expect((await post()).code).toBe(201);
    expect(counted).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', UUID_A);
  });

  it('counts only AFTER taking the line lock (so concurrent uploads cannot all pass the count)', async () => {
    const order: string[] = [];
    locked.mockImplementation(async () => { order.push('lock'); return {}; });
    counted.mockImplementation(async () => { order.push('count'); return 0; });
    sqlMock.mockResolvedValueOnce([{ id: UUID_A }]);
    sqlMock.mockResolvedValueOnce([{ id: 'new' }]);
    await post();
    expect(order).toEqual(['lock', 'count']);
  });

  it('a lock that cannot be taken inserts nothing', async () => {
    locked.mockRejectedValue(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
    await post().catch(() => undefined); // answered 503 by respondIfLockTimeout, or rethrown to the error handler
    expect(inserted()).toBe(false);
  });
});

describe('GET include_settled', () => {
  it('without it, lists the line\'s own rows only and reads no settled documents', async () => {
    const r = await callRoute(handler, { query: { bankTransactionId: UUID_A } });
    expect(settledList).not.toHaveBeenCalled();
    expect((r.body as { data: unknown[] }).data).toHaveLength(1);
  });

  it('with include_settled=1, appends the settled documents after the own rows, marked and counted', async () => {
    const r = await callRoute(handler, { query: { bankTransactionId: UUID_A, include_settled: '1' } });
    expect(settledList).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', UUID_A);
    const data = (r.body as { data: Record<string, unknown>[] }).data;
    expect(data.map((d) => d.id)).toEqual(['a1', `settled:d1:b1:p1`]);
    expect(data[1]).toMatchObject({
      source: 'settled_document', bank_transaction_id: UUID_A, file_url: 'https://files.test/SIV-1.pdf', file_name: 'SIV-1.pdf',
      content_type: 'application/pdf', via: { payment_number: 'SP-1' }, settles: { number: 'SIV-1', applied: 1000 },
    });
    expect(r.headers['X-Settled-Documents-Total']).toBe('1');
    expect(r.headers['X-Attachments-Total']).toBe('1'); // still the line's own count
  });

  it('a foreign line is refused before the settled read', async () => {
    sqlMock.mockResolvedValue([]);
    const r = await callRoute(handler, { query: { bankTransactionId: UUID_A, include_settled: '1' } });
    expect(r.code).toBe(403);
    expect(settledList).not.toHaveBeenCalled();
  });
});
