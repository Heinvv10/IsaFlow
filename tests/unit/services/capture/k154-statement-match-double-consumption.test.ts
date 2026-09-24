/**
 * K-154 RED — supplier statement reconciliation lets ONE ledger invoice satisfy
 * MANY statement lines.
 *
 * buildInserts (supplierStatementMatchHelper.ts:171) passes the full `invoices`
 * array to matchLine for every statement line and never removes an invoice once
 * it has been consumed. Two statement lines that both look like the same invoice
 * therefore both come back matched to it, and a second, genuinely-unmatched
 * ledger invoice is then reported as 'missing_in_statement'.
 */
import { describe, it, expect } from 'vitest';
import { buildInserts } from '@/modules/accounting/services/capture/supplierStatementMatchHelper';

describe('K-154 buildInserts must consume a matched invoice', () => {
  it('does not match the same invoice to two statement lines (exact ref path)', () => {
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'INV-001', invoiceDate: '2026-03-10', totalAmount: 1000 },
    ];
    // Supplier statement double-charges the same invoice number.
    const lines = [
      { date: '2026-03-10', reference: 'INV-001', debit: 1000 },
      { date: '2026-03-10', reference: 'INV-001', debit: 1000 },
    ];

    const { inserts } = buildInserts('recon-1', lines, invoices);
    const matchedToInv1 = inserts.filter((i) => i.matchedInvoiceId === 'inv-1');

    // One statement line may claim inv-1; the duplicate must be reported as
    // unmatched (missing_in_isaflow) so the double charge is visible.
    expect(matchedToInv1).toHaveLength(1);
  });

  it('matches two equal statement lines to two distinct invoices (fuzzy path)', () => {
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'A-1', invoiceDate: '2026-03-10', totalAmount: 1000 },
      { id: 'inv-2', invoiceNumber: 'A-2', invoiceDate: '2026-03-10', totalAmount: 1000 },
    ];
    // Statement references do not match ledger invoice numbers, so both lines
    // fall through to the fuzzy amount+date branch.
    const lines = [
      { date: '2026-03-10', reference: 'STMT-9', debit: 1000 },
      { date: '2026-03-10', reference: 'STMT-9', debit: 1000 },
    ];

    const { inserts, matchedIds } = buildInserts('recon-2', lines, invoices);

    // Both invoices are genuinely on the statement — neither may be flagged
    // missing, and the two lines must not collapse onto the same invoice.
    expect(matchedIds.size).toBe(2);
    expect(inserts.filter((i) => i.mismatchReason === 'missing_in_statement')).toHaveLength(0);
  });
});

describe('K-154 adjacent cases', () => {
  it('still reports a ledger invoice absent from the statement as missing', () => {
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'INV-001', invoiceDate: '2026-03-10', totalAmount: 1000 },
      { id: 'inv-2', invoiceNumber: 'INV-002', invoiceDate: '2026-03-11', totalAmount: 2000 },
    ];
    const lines = [{ date: '2026-03-10', reference: 'INV-001', debit: 1000 }];

    const { inserts, matchedIds } = buildInserts('recon-3', lines, invoices);

    expect(matchedIds.size).toBe(1);
    const missing = inserts.filter((i) => i.mismatchReason === 'missing_in_statement');
    expect(missing).toHaveLength(1);
    expect(missing[0].matchedInvoiceId).toBe('inv-2');
  });

  it('consumes an invoice claimed with a mismatch reason, not only a clean match', () => {
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'INV-001', invoiceDate: '2026-03-10', totalAmount: 1000 },
    ];
    // First line carries the right reference but the wrong amount -> amount_diff,
    // which still claims inv-1. The second identical line must find nothing.
    const lines = [
      { date: '2026-03-10', reference: 'INV-001', debit: 1500 },
      { date: '2026-03-10', reference: 'INV-001', debit: 1500 },
    ];

    const { inserts } = buildInserts('recon-4', lines, invoices);

    expect(inserts[0].matchedInvoiceId).toBe('inv-1');
    expect(inserts[0].mismatchReason).toBe('amount_diff');
    expect(inserts[1].matchedInvoiceId).toBeNull();
    expect(inserts[1].mismatchReason).toBe('missing_in_isaflow');
  });

  it('matches three repeated statement lines against three distinct invoices', () => {
    const invoices = [
      { id: 'inv-1', invoiceNumber: 'A-1', invoiceDate: '2026-03-10', totalAmount: 500 },
      { id: 'inv-2', invoiceNumber: 'A-2', invoiceDate: '2026-03-10', totalAmount: 500 },
      { id: 'inv-3', invoiceNumber: 'A-3', invoiceDate: '2026-03-10', totalAmount: 500 },
    ];
    const lines = [
      { date: '2026-03-10', reference: 'STMT-1', debit: 500 },
      { date: '2026-03-10', reference: 'STMT-2', debit: 500 },
      { date: '2026-03-10', reference: 'STMT-3', debit: 500 },
    ];

    const { inserts, matchedIds } = buildInserts('recon-5', lines, invoices);

    expect(matchedIds).toEqual(new Set(['inv-1', 'inv-2', 'inv-3']));
    expect(inserts.filter((i) => i.mismatchReason === 'missing_in_statement')).toHaveLength(0);
  });
});
