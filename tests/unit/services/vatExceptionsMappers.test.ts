// mapDeclaredElsewhere — the "Marked by" name resolution (LEFT JOIN users in
// vatUnpostedInvoices.findVatDeclaredElsewhere). The UUID id must never be
// shown when a display name or email resolves.
import { describe, expect, it } from 'vitest';
import { mapDeclaredElsewhere, mapUnpostedInvoice } from '@/modules/accounting/services/reports/vatExceptionsMappers';

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

// mapUnpostedInvoice — the SQL's reason CASE result passes straight through
// for every recognised value (Hein, 2026-09-27 added 'journal_dated_after_period'),
// with an unrecognised value defensively falling back to 'no_journal'.
describe('mapUnpostedInvoice: reason pass-through', () => {
  const row = {
    kind: 'customer', invoice_id: 'ci-1', invoice_number: 'INV-1',
    counterparty_name: 'Acme', invoice_date: '2026-02-15', unposted_vat: 150,
  };

  it.each(['no_journal', 'journal_not_posted', 'journal_reversed', 'journal_dated_after_period'])(
    'passes %s through unchanged', (reason) => {
      expect(mapUnpostedInvoice({ ...row, reason }).reason).toBe(reason);
    },
  );

  it('falls back to no_journal for an unrecognised reason', () => {
    expect(mapUnpostedInvoice({ ...row, reason: 'something_new' }).reason).toBe('no_journal');
  });
});
