/**
 * The AR / AP wizard pages' row handling, pulled out so it can be tested.
 *
 * - The preview matched contacts by SUBSTRING while the server matches with
 *   `matchContact` (exact, else dice >= 0.7), so the preview could say "matched"
 *   for a row the server then rejected, and the other way round. Both now use
 *   the same function.
 * - AP sent the preview's own substring auto-match as an authoritative
 *   `supplierId`, overriding the server's matcher. Only a match the USER chose
 *   travels as an id now.
 * - Amounts went through parseFloat(...) || 0 (garbage imported as 0, "1 234,56"
 *   as 1) and dates had to be YYYY-MM-DD.
 */
import { describe, it, expect } from 'vitest';
import {
  matchRowContact,
  buildInvoicePayload,
} from '@/components/accounting/migration/invoiceImportRows';
import { matchContact } from '@/modules/accounting/services/core/migrationContactMatch';

const contacts = [
  { id: 'c1', name: 'Acme Corporation' },
  { id: 'c2', name: 'Beta Supplies' },
  { id: 'c3', name: 'Acme' },
];

describe('matchRowContact', () => {
  it('rates an exact (case-insensitive) match HIGH', () => {
    expect(matchRowContact('beta supplies', contacts)).toEqual({ id: 'c2', confidence: 'HIGH' });
  });

  it('matches a close spelling the way the server does', () => {
    const r = matchRowContact('Beta Supplies.', contacts);
    expect(r.id).toBe('c2');
    expect(r.confidence).not.toBe('NONE');
  });

  it('does NOT match on a bare substring the server would reject', () => {
    // "Acme Corp" is a substring of "Acme Corporation" and contains "Acme":
    // the old preview claimed a match; check the preview agrees with the server.
    for (const name of ['Acme Corp', 'Corp', 'Supplies', 'Zeta Holdings']) {
      expect(matchRowContact(name, contacts).id ?? null).toBe(matchContact(name, contacts));
    }
    // "Corp" is inside "Acme Corporation" — substring said yes, the server says no.
    expect(matchContact('Corp', contacts)).toBeNull();
    expect(matchRowContact('Corp', contacts)).toEqual({ confidence: 'NONE' });
  });

  it('returns NONE for a blank name', () => {
    expect(matchRowContact('', contacts)).toEqual({ confidence: 'NONE' });
  });
});

describe('buildInvoicePayload', () => {
  const mapped = {
    invoice_number: 'INV-1', invoice_date: '03/04/2026', due_date: '03 May 2026',
    subtotal: 'R 1 000,00', tax_amount: '150,00', total_amount: '1 150,00', amount_paid: '', reference: 'PO-1',
  };

  it('normalises SA dates and amounts', () => {
    const { payload, problems } = buildInvoicePayload(mapped);
    expect(problems).toEqual([]);
    expect(payload).toMatchObject({
      invoiceNumber: 'INV-1', invoiceDate: '2026-04-03', dueDate: '2026-05-03',
      subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 0, reference: 'PO-1',
    });
  });

  it('reports a garbage amount instead of sending 0', () => {
    const { problems } = buildInvoicePayload({ ...mapped, total_amount: '1150abc' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('total_amount');
    expect(problems[0]).toContain('1150abc');
  });

  it('reports an unreadable date', () => {
    const { problems } = buildInvoicePayload({ ...mapped, invoice_date: '31/02/2026' });
    expect(problems[0]).toContain('invoice_date');
  });

  it('leaves a blank date for the route to refuse by row, rather than blocking the file', () => {
    const { payload, problems } = buildInvoicePayload({ ...mapped, due_date: '' });
    expect(problems).toEqual([]);
    expect(payload.dueDate).toBe('');
  });

  it('leaves an unmapped invoice number absent rather than blank', () => {
    const { invoice_number: _omit, ...rest } = mapped;
    const { payload } = buildInvoicePayload(rest);
    expect('invoiceNumber' in payload).toBe(false);
  });
});
