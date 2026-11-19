/**
 * Intercompany P2: copying the sender's sealed PDF onto the receiver's draft bill. The bytes are read only from under the SENDER's own
 * storage prefix (a path in another company's prefix is refused before any read), must hash to what the message says, and land under
 * the RECEIVER's prefix; a copy that fails never throws (the draft stands without it).
 */
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ download: vi.fn(), upload: vi.fn(), sql: vi.fn(async () => []) }));
vi.mock('@supabase/storage-js', () => ({ StorageClient: class { from() { return { download: m.download, upload: m.upload }; } createBucket() { return { error: null }; } } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(m.sql, { unsafe: (t: string) => t }),
  withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ createSupplierInvoice: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({ createCreditNote: vi.fn() }));

import { copySenderPdf } from '@/modules/accounting/services/intercompany/acceptDocuments';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECEIVER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';
const bytes = Buffer.from('%PDF-1.4 sealed invoice');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const pdf = (path = `${SENDER}/${DOC}.pdf`, sha256 = hash) => ({ path, sha256 });
const copy = (p = pdf()) => copySenderPdf(RECEIVER, SENDER, 'user', 'bill', 'INV-1', p);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = 'http://storage.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  m.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
  m.upload.mockResolvedValue({ error: null });
});

describe('copySenderPdf', () => {
  it('reads the sender\'s file, stores it under the RECEIVER\'s prefix and points the bill at it', async () => {
    expect(await copy()).toBe(true);
    expect(m.download).toHaveBeenCalledWith(`${SENDER}/${DOC}.pdf`);
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(String(m.upload.mock.calls[0]![0]).startsWith(`${RECEIVER}/`)).toBe(true);
    const texts = m.sql.mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => t.includes('INSERT INTO captured_documents'))).toBe(true);
    expect(texts.some((t) => t.includes('UPDATE supplier_invoices SET source_document_id'))).toBe(true);
  });

  it('refuses a path under another company\'s prefix before any read', async () => {
    expect(await copy(pdf(`${THIRD}/${DOC}.pdf`))).toBe(false);
    expect(await copy(pdf(`${SENDER}/../${THIRD}/${DOC}.pdf`))).toBe(false);
    expect(m.download).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('refuses bytes that do not hash to what the message says, and stores nothing', async () => {
    expect(await copy(pdf(undefined, 'f'.repeat(64)))).toBe(false);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('a missing file or a storage fault is false, never a throw', async () => {
    m.download.mockResolvedValue({ data: null, error: { message: 'Object not found', status: 404, statusCode: '404' } });
    expect(await copy()).toBe(false);
    m.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
    m.upload.mockResolvedValue({ error: { message: 'down' } });
    expect(await copy()).toBe(false);
  });
});
