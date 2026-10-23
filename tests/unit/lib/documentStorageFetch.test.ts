/**
 * fetchRawBytes fabricates a hash when the column is null (legacy rows), so a caller that wants to VERIFY the bytes
 * needs the recorded value itself: `storedHash` is the raw_bytes_sha256 column, null when the row has none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/supabaseStorage', () => ({
  uploadCapturedDocument: vi.fn(),
  downloadCapturedDocument: m.download,
  CAPTURED_DOCS_BUCKET: 'captured-documents',
}));

import { fetchRawBytes, sha256 } from '@/lib/documentStorage';

const BYTES = Buffer.from('%PDF-1.4 fetch');
const row = (over: Record<string, unknown> = {}) => ({
  storage_bucket: 'captured-documents', storage_path: 'co/doc', raw_bytes_sha256: sha256(BYTES), raw_bytes_size: BYTES.length,
  file_type: 'pdf', ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.download.mockResolvedValue(BYTES);
});

describe('fetchRawBytes: storedHash', () => {
  it('is the recorded column value', async () => {
    m.sql.mockResolvedValue([row({ raw_bytes_sha256: 'recorded-hash' })]);
    expect(await fetchRawBytes('d', 'c')).toMatchObject({ storedHash: 'recorded-hash', hash: 'recorded-hash', fileType: 'pdf' });
  });

  it('is null when the row has none, while `hash` is still fabricated from the bytes', async () => {
    m.sql.mockResolvedValue([row({ raw_bytes_sha256: null })]);
    expect(await fetchRawBytes('d', 'c')).toMatchObject({ storedHash: null, hash: sha256(BYTES) });
  });

  it('is still null for no pointer (the whole result is null)', async () => {
    m.sql.mockResolvedValue([row({ storage_path: null })]);
    expect(await fetchRawBytes('d', 'c')).toBeNull();
  });
});
