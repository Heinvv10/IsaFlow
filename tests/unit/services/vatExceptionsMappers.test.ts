// mapDeclaredElsewhere — the "Marked by" name resolution (LEFT JOIN users in
// vatUnpostedInvoices.findVatDeclaredElsewhere). The UUID id must never be
// shown when a display name or email resolves.
import { describe, expect, it } from 'vitest';
import { mapDeclaredElsewhere } from '@/modules/accounting/services/reports/vatExceptionsMappers';

const baseRow = {
  kind: 'customer',
  invoice_id: 'ci-1',
  invoice_number: 'INV-1',
  counterparty_name: 'Acme',
  invoice_date: '2026-07-01',
  unposted_vat: 90,
  marked_at: '2026-07-10T00:00:00.000Z',
  marked_by: '4b6a1e2a-0000-4000-8000-000000000001',
  marked_reason: 'Historical import',
};

describe('mapDeclaredElsewhere: markedByName', () => {
  it('uses the joined display name when the user row resolves', () => {
    const row = mapDeclaredElsewhere({ ...baseRow, marked_by_name: 'Jane Doe' });
    expect(row.markedByName).toBe('Jane Doe');
    expect(row.markedBy).toBe(baseRow.marked_by);
  });

  it('falls back to the id when no user row resolves (marked_by_name null)', () => {
    const row = mapDeclaredElsewhere({ ...baseRow, marked_by_name: null });
    expect(row.markedByName).toBe(baseRow.marked_by);
  });

  it('falls back to the id when the joined name is blank whitespace', () => {
    const row = mapDeclaredElsewhere({ ...baseRow, marked_by_name: '   ' });
    expect(row.markedByName).toBe(baseRow.marked_by);
  });
});
