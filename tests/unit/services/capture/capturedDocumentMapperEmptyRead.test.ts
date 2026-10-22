/**
 * A Document Capture row inserted for a background read carries
 * extracted_data '{}' until the read finishes (and stays '{}' when the read
 * fails). The API must answer extractedData null for it, not {}: the document
 * page reads extracted.warnings / lineItems whenever extractedData is truthy,
 * and an empty object crashed it ("Cannot read properties of undefined").
 */
import { describe, expect, it } from 'vitest';
import { mapCapturedDocumentRow } from '@/modules/accounting/services/capture/capturedDocumentMapper';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const row = (extracted: unknown, readState = 'reading') => ({
  id: 'd1', file_name: 'a.pdf', file_type: 'pdf', file_size: 1, document_type: null,
  extracted_data: extracted, vendor_name: null, document_date: null, reference_number: null,
  total_amount: null, vat_amount: null, status: 'pending', matched_invoice_id: null,
  matched_bank_tx_id: null, notes: null, uploaded_by: null, created_at: '2026-10-22T09:59:00Z',
  read_state: readState, read_error: null, read_heartbeat_at: null,
});

describe('mapCapturedDocumentRow — an empty extraction is no extraction', () => {
  it('maps extracted_data {} on a row being read to null', () => {
    expect(mapCapturedDocumentRow(row({}), NOW).extractedData).toBeNull();
  });

  it('maps the string form "{}" (a text-typed driver) to null', () => {
    expect(mapCapturedDocumentRow(row('{}', 'failed'), NOW).extractedData).toBeNull();
  });

  it('keeps a real extraction', () => {
    const data = { vendorName: 'Karoo', warnings: [], lineItems: [] };
    expect(mapCapturedDocumentRow(row(data, 'done'), NOW).extractedData).toEqual(data);
  });
});
