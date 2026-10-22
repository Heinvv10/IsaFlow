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

import { CapturedDocumentMissingError, downloadCapturedDocument } from '@/lib/supabaseStorage';

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SUPABASE_URL = 'http://storage.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
});

describe('downloadCapturedDocument', () => {
  it('returns the bytes', async () => {
    m.download.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    expect([...await downloadCapturedDocument('b', 'p')]).toEqual([1, 2, 3]);
  });

  it.each([
    ['statusCode 404', { message: 'Object not found', status: 400, statusCode: '404' }],
    ['status 404', { message: 'gone', status: 404, statusCode: '404' }],
    ['message only', { message: 'Object not found' }],
  ])('throws CapturedDocumentMissingError for a missing object (%s)', async (_n, error) => {
    m.download.mockResolvedValue({ data: null, error });
    await expect(downloadCapturedDocument('b', 'co/doc')).rejects.toBeInstanceOf(CapturedDocumentMissingError);
  });

  it.each([
    ['a gateway error', { message: 'Bad gateway', status: 502, statusCode: '502' }],
    ['an auth error', { message: 'Invalid JWT', status: 401, statusCode: '401' }],
    ['a fetch failure', { message: 'fetch failed' }],
  ])('throws a plain Error for %s, so the read stays retryable', async (_n, error) => {
    m.download.mockResolvedValue({ data: null, error });
    const err = await downloadCapturedDocument('b', 'co/doc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CapturedDocumentMissingError);
  });

  it('throws a plain Error when Storage answers with no data and no error', async () => {
    m.download.mockResolvedValue({ data: null, error: null });
    const err = await downloadCapturedDocument('b', 'co/doc').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CapturedDocumentMissingError);
  });
});
