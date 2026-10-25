/**
 * downloadCapturedDocument tells an object the bucket does not have (the file is gone: not retryable) from any other
 * Storage failure (an outage: retryable) by a typed error, so the capture read job does not parse messages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@supabase/storage-js', () => ({
  StorageClient: class { from() { return { download: m.download }; } },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CAPTURED_DOCS_BUCKET, CUSTOMER_INVOICES_BUCKET, CapturedDocumentMissingError, StorageObjectOutsideCompanyError, downloadCapturedDocument, signedUrlForCapturedDocument } from '@/lib/supabaseStorage';

const B = CAPTURED_DOCS_BUCKET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SUPABASE_URL = 'http://storage.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
});

describe('downloadCapturedDocument', () => {
  it('returns the bytes', async () => {
    m.download.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    expect([...await downloadCapturedDocument(B, 'co/p', 'co')]).toEqual([1, 2, 3]);
  });

  it.each([
    ['the Storage API\'s own shape (status 400, statusCode 404)', { message: 'Object not found', status: 400, statusCode: '404' }],
    ['status 404', { message: 'Object not found', status: 404, statusCode: '404' }],
    ['status 404 only', { message: 'Object not found', status: 404 }],
    ['different case', { message: 'object not found', statusCode: '404' }],
  ])('throws CapturedDocumentMissingError for a 404 that names the object (%s)', async (_n, error) => {
    m.download.mockResolvedValue({ data: null, error });
    await expect(downloadCapturedDocument(B, 'co/doc', 'co')).rejects.toBeInstanceOf(CapturedDocumentMissingError);
  });

  it.each([
    ['a bucket that is not found', { message: 'Bucket not found', status: 404, statusCode: '404' }],
    ['a project that is not found', { message: 'Project not found', status: 404, statusCode: '404' }],
    ['a gateway 404 with no object in the message', { message: 'Not Found', status: 404, statusCode: '404' }],
    ['a bare 404', { status: 404, statusCode: '404' }],
    ['an empty 404 message', { message: '', status: 404 }],
    ['"Object not found" with no 404 at all', { message: 'Object not found' }],
    ['"Object not found" under a 500', { message: 'Object not found', status: 500, statusCode: '500' }],
    ['a gateway error', { message: 'Bad gateway', status: 502, statusCode: '502' }],
    ['an auth error', { message: 'Invalid JWT', status: 401, statusCode: '401' }],
    ['a fetch failure', { message: 'fetch failed' }],
  ])('throws a plain Error for %s, so the read stays retryable', async (_n, error) => {
    m.download.mockResolvedValue({ data: null, error });
    const err = await downloadCapturedDocument(B, 'co/doc', 'co').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CapturedDocumentMissingError);
  });

  it('throws a plain Error when Storage answers with no data and no error', async () => {
    m.download.mockResolvedValue({ data: null, error: null });
    const err = await downloadCapturedDocument(B, 'co/doc', 'co').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CapturedDocumentMissingError);
  });
});

// S-07e: the pointer columns are app-writable and this client bypasses storage RLS.
describe('only the reading company\'s own objects', () => {
  it.each([
    ['another company\'s object', 'victim/doc'],
    ['a prefix that only starts like it', 'co-other/doc'],
    ['a climb out of the prefix', 'co/../victim/doc'],
    ['an empty segment', 'co//doc'],
    ['no prefix at all', 'doc'],
    ['the prefix alone', 'co/'],
    ['a dot segment', 'co/./doc'],
    ['a percent-encoded climb', 'co/%2e%2e/victim/doc'],
    ['a backslash climb', 'co/..\\victim\\doc'],
    ['a query string', 'co/doc?x=1'],
    ['a fragment', 'co/doc#x'],
    ['a control character', 'co/doc\n'],
    ['a hidden dot-file', 'co/.doc'],
  ])('refuses %s without asking Storage', async (_, path) => {
    await expect(downloadCapturedDocument(B, path, 'co')).rejects.toBeInstanceOf(StorageObjectOutsideCompanyError);
    await expect(signedUrlForCapturedDocument(B, path, 'co')).rejects.toBeInstanceOf(StorageObjectOutsideCompanyError);
    expect(m.download).not.toHaveBeenCalled();
  });

  it('refuses a bucket the app does not write, even for its own key', async () => {
    await expect(downloadCapturedDocument('avatars', 'co/doc', 'co')).rejects.toBeInstanceOf(StorageObjectOutsideCompanyError);
    expect(m.download).not.toHaveBeenCalled();
  });

  it.each([
    ['a captured document', CAPTURED_DOCS_BUCKET, 'co/0b9d1c1e-3f7a-4c56-9a1e-2f3b4c5d6e7f'],
    ['an invoice PDF', CUSTOMER_INVOICES_BUCKET, 'co/0b9d1c1e-3f7a-4c56-9a1e-2f3b4c5d6e7f.pdf'],
  ])('serves %s the app wrote', async (_, bucket, path) => {
    m.download.mockResolvedValue({ data: new Blob([new Uint8Array([7])]), error: null });
    expect([...await downloadCapturedDocument(bucket, path, 'co')]).toEqual([7]);
  });
});
