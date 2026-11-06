/**
 * /api/accounting/captured-document-file serves one of the company's captured documents so a bank line can show a
 * linked document too large to copy. Its bytes must never be a renderable response: always octet-stream, nosniff, a
 * sandbox CSP, attachment, and a saved name whose extension only the bytes can choose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const fetchRaw = vi.fn();
vi.mock('@/lib/documentStorage', () => ({ fetchRawBytes: (...a: unknown[]) => fetchRaw(...a) }));
vi.mock('@/lib/supabaseStorage', () => ({ CapturedDocumentMissingError: class extends Error {} }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler, { capturedDownloadName, config } from '../../../pages/api/accounting/captured-document-file';
import { CapturedDocumentMissingError } from '@/lib/supabaseStorage';

const ID = '11111111-1111-4111-8111-111111111111';
interface Res { code: number; body: unknown; headers: Record<string, string> }
async function call(query: Record<string, unknown>, method = 'GET'): Promise<Res> {
  const out: Res = { code: 0, body: undefined, headers: {} };
  const res = {
    status(c: number) { out.code = c; return this; },
    setHeader(k: string, v: string) { out.headers[k] = v; return this; },
    send(b: unknown) { out.body = b; return this; },
    json(b: unknown) { out.body = b; return this; },
    end() { return this; },
  };
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    { method, companyId: 'co-1', query } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return out;
}
const raw = (buffer: Buffer) => ({ buffer, hash: 'h', storedHash: 'h', size: buffer.length, fileType: 'application/pdf' });

beforeEach(() => { fetchRaw.mockReset(); });

describe('captured-document-file', () => {
  it('serves the bytes of this company\'s document as an inert download', async () => {
    const pdf = Buffer.from('%PDF-1.7\n...');
    fetchRaw.mockResolvedValue(raw(pdf));
    const r = await call({ id: ID });
    expect(fetchRaw).toHaveBeenCalledWith(ID, 'co-1');
    expect(r.code).toBe(200);
    expect(r.body).toBe(pdf);
    expect(r.headers['Content-Type']).toBe('application/octet-stream');
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.headers['Content-Security-Policy']).toMatch(/^sandbox/);
    expect(r.headers['Cache-Control']).toBe('private, no-store');
    expect(r.headers['Content-Disposition']).toBe('attachment; filename="document.pdf"');
  });

  it('names a saved file from its bytes, never from its claim', () => {
    expect(capturedDownloadName(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('document.jpg');
    expect(capturedDownloadName(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('document.tif');
    expect(capturedDownloadName(Buffer.from('<html><script>alert(1)</script>'))).toBe('document.bin');
  });

  it('is not found for another company\'s document, or one whose bytes are gone', async () => {
    fetchRaw.mockResolvedValue(null);
    expect((await call({ id: ID })).code).toBe(404);
    fetchRaw.mockRejectedValue(new CapturedDocumentMissingError('gone'));
    expect((await call({ id: ID })).code).toBe(404);
  });

  it('lets any other storage failure reach the error handler', async () => {
    fetchRaw.mockRejectedValue(new Error('storage down'));
    await expect(call({ id: ID })).rejects.toThrow('storage down');
  });

  it('refuses a malformed id before reading anything, and any method but GET', async () => {
    expect((await call({ id: '../etc/passwd' })).code).toBe(400);
    expect((await call({ id: [ID, ID] })).code).toBe(400);
    expect((await call({ id: ID }, 'POST')).code).toBe(405);
    expect(fetchRaw).not.toHaveBeenCalled();
  });

  it('allows a response the size of the largest captured document', () => {
    expect(config.api.responseLimit).toBe('12mb');
  });
});
