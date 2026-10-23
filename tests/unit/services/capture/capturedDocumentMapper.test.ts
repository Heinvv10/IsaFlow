/** The API shape of a captured_documents row carries `retryable` (from the stored-file pointer) but never the pointer. */
import { describe, expect, it } from 'vitest';
import { mapCapturedDocumentRow } from '@/modules/accounting/services/capture/capturedDocumentMapper';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1', file_name: 'a.pdf', file_type: 'pdf', file_size: 10, document_type: null, extracted_data: '{}', vendor_name: null,
  document_date: null, reference_number: null, total_amount: null, vat_amount: null, status: 'pending', matched_invoice_id: null,
  matched_bank_tx_id: null, notes: null, uploaded_by: null, created_at: '2026-10-22T09:00:00.000Z',
  read_state: 'failed', read_error: 'Boom.', read_heartbeat_at: null, storage_bucket: 'captured-documents', storage_path: 'co/d1',
  raw_bytes_sha256: 'abc', posted_at: null, read_attempt: 2, ...over,
});

describe('mapCapturedDocumentRow: retryable', () => {
  it('is true for a failed, stored, pending, unposted document', () => {
    expect(mapCapturedDocumentRow(row(), NOW)).toMatchObject({ readState: 'failed', readError: 'Boom.', retryable: true });
  });

  it('is false for an unstored, posted or settled document, and while it is reading', () => {
    expect(mapCapturedDocumentRow(row({ storage_path: null }), NOW).retryable).toBe(false);
    expect(mapCapturedDocumentRow(row({ posted_at: '2026-10-22T09:30:00.000Z' }), NOW).retryable).toBe(false);
    expect(mapCapturedDocumentRow(row({ status: 'rejected' }), NOW).retryable).toBe(false);
    expect(mapCapturedDocumentRow(row({ read_state: 'reading', created_at: new Date(NOW - 60_000).toISOString() }), NOW).retryable).toBe(false);
  });

  it('never returns the storage pointer, the hash or the attempt counter', () => {
    const json = JSON.stringify(mapCapturedDocumentRow(row(), NOW));
    for (const leak of ['storage_path', 'storage_bucket', 'co/d1', 'captured-documents', 'abc', 'read_attempt']) {
      expect(json).not.toContain(leak);
    }
  });
});
