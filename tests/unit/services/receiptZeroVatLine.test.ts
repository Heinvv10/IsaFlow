/**
 * A zero-VAT receipt must still post.
 *
 * buildExpenseJournalFromReceipt emits its VAT leg unconditionally
 * (receiptToJournalService.ts:141). validateReceiptExtraction only WARNS when
 * vatAmount is null — it accepts a zero — so a zero-rated or exempt receipt
 * (bank charges, basic foodstuffs, a foreign supplier) produces a leg of
 * { debit: 0, credit: 0 }.
 *
 * That was harmless while the route hand-INSERTed its lines. Routing
 * receipt-to-journal through createJournalEntry made it fatal:
 * validateJournalLine rejects a line with neither debit nor credit, so every
 * zero-VAT receipt would have 500'd. The callers filter zero-value legs before
 * handing the lines over — the same guard expenseClaimService applies with
 * `if (netAmount === 0) continue`.
 *
 * This pins the contract the two routes depend on: the raw build DOES produce
 * an unusable leg, and filtering it yields a journal that validates and still
 * balances. If the builder ever stops emitting the empty leg, the first
 * assertion fails and the filters can go.
 */
import { describe, it, expect } from 'vitest';

import { buildExpenseJournalFromReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const ACCOUNTS = {
  expenseAccountId: 'acct-expense',
  vatInputAccountId: 'acct-vat-input',
  bankAccountId: 'acct-bank',
};

/** The shape the two posting routes build before handing lines to the service. */
function toJournalLines(lines: Array<{ accountId: string; debit: number; credit: number }>) {
  return lines
    .filter(l => l.debit !== 0 || l.credit !== 0)
    .map(l => ({ glAccountId: l.accountId, debit: l.debit, credit: l.credit }));
}

function extracted(over: Partial<ExtractedDocument>): ExtractedDocument {
  return {
    totalAmount: 500,
    subtotal: 500,
    vatAmount: 0,
    vatRate: 0,
    date: '2026-08-13',
    vendorName: 'Standard Bank',
    confidence: 0.95,
    ...over,
  } as ExtractedDocument;
}

describe('zero-VAT receipts', () => {
  it('the builder emits an unusable zero/zero VAT leg', () => {
    const built = buildExpenseJournalFromReceipt(extracted({}), ACCOUNTS);

    const vatLeg = built.lines.find(l => l.accountId === ACCOUNTS.vatInputAccountId);
    expect(vatLeg).toMatchObject({ debit: 0, credit: 0 });
  });

  it('passing that leg through unfiltered would be REJECTED (this is the 500)', () => {
    const built = buildExpenseJournalFromReceipt(extracted({}), ACCOUNTS);

    const unfiltered = built.lines.map(l => ({
      glAccountId: l.accountId, debit: l.debit, credit: l.credit,
    }));
    const result = validateJournalEntry(unfiltered);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/non-zero debit or credit/);
  });

  it('filtering zero-value legs yields a valid, balanced entry', () => {
    const built = buildExpenseJournalFromReceipt(extracted({}), ACCOUNTS);

    const result = validateJournalEntry(toJournalLines(built.lines));

    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(500);
    expect(result.totalCredit).toBe(500);
  });

  it('also covers the derived path, where vatRate 0 makes VAT zero', () => {
    // subtotal/vatAmount absent → derived from total and vatRate.
    const built = buildExpenseJournalFromReceipt(
      extracted({ subtotal: null, vatAmount: null, vatRate: 0 }),
      ACCOUNTS,
    );

    expect(built.lines.find(l => l.accountId === ACCOUNTS.vatInputAccountId))
      .toMatchObject({ debit: 0, credit: 0 });
    expect(validateJournalEntry(toJournalLines(built.lines)).valid).toBe(true);
  });

  it('leaves a standard-rated receipt fully intact — nothing is dropped', () => {
    const built = buildExpenseJournalFromReceipt(
      extracted({ totalAmount: 1150, subtotal: 1000, vatAmount: 150, vatRate: 15 }),
      ACCOUNTS,
    );

    const lines = toJournalLines(built.lines);
    expect(lines).toHaveLength(3);
    const result = validateJournalEntry(lines);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(1150);
  });
});
