/**
 * K-072 — the receipt-to-journal builder claims input VAT on entertainment.
 *
 * receiptToJournalService.ts:56 routes restaurant merchants to account 5600
 * and parseReceiptType (:155) labels them 'meals'. buildExpenseJournalFromReceipt
 * (:139-143) then emits a `vatInputAccountId` debit unconditionally — the
 * receipt type it just computed is never consulted.
 *
 * Section 17(2)(a) of the VAT Act denies input tax on entertainment. Both
 * consumers (pages/api/accounting/receipt-to-journal.ts:86 and
 * pages/api/accounting/capture/[id]/post-expense.ts:209) post the returned
 * lines through createJournalEntry, so the denied claim reaches the ledger.
 *
 * The lines carry no `vatType` field, so scripts/ci/check-vat-guard-coverage.ts
 * does not see this path at all.
 *
 * RED for the claimed reason: a Spur receipt must not debit VAT Input, and the
 * expense leg must carry the VAT-inclusive cost.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExpenseJournalFromReceipt,
  parseReceiptType,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const receipt = (overrides?: Partial<ExtractedDocument>): ExtractedDocument => ({
  documentType: 'receipt',
  vendorName: 'Spur Steak Ranches Rosebank',
  vendorVatNumber: null,
  vendorAddress: null,
  vendorBankDetails: null,
  customerName: null,
  customerVatNumber: null,
  date: '2026-03-20',
  dueDate: null,
  paymentTerms: null,
  referenceNumber: 'REC-101',
  purchaseOrderRef: null,
  currency: 'ZAR',
  subtotal: 1000,
  vatAmount: 150,
  vatRate: 15,
  totalAmount: 1150,
  lineItems: [],
  rawText: '',
  confidence: 0.9,
  warnings: [],
  extractionMethod: 'vlm',
  ...overrides,
});

const accountIds = {
  expenseAccountId: 'gl-5600',
  vatInputAccountId: 'gl-1140',
  bankAccountId: 'gl-1110',
};

describe('K-072 entertainment input VAT', () => {
  it('classifies a restaurant receipt as meals', () => {
    expect(parseReceiptType(receipt())).toBe('meals');
  });

  it('does not debit VAT Input on an entertainment receipt', () => {
    const journal = buildExpenseJournalFromReceipt(receipt(), accountIds);
    const vatLeg = journal.lines.find(l => l.accountId === accountIds.vatInputAccountId);
    expect(vatLeg?.debit ?? 0).toBe(0);
  });

  it('charges the full VAT-inclusive amount to the expense account', () => {
    const journal = buildExpenseJournalFromReceipt(receipt(), accountIds);
    const expenseLeg = journal.lines.find(l => l.accountId === accountIds.expenseAccountId);
    expect(expenseLeg?.debit).toBe(1150);
  });

  it('still claims input VAT on a non-entertainment receipt', () => {
    // Guards the fix: an office-supplies receipt keeps its claim.
    const office = receipt({ vendorName: 'Waltons Stationery' });
    const journal = buildExpenseJournalFromReceipt(office, {
      ...accountIds,
      expenseAccountId: 'gl-5100',
    });
    const vatLeg = journal.lines.find(l => l.accountId === accountIds.vatInputAccountId);
    expect(vatLeg?.debit).toBe(150);
  });
});

describe('K-072 adjacent cases', () => {
  it('keeps the claim on a travel receipt, which shares account 5600', () => {
    // The denial keys off the receipt TYPE, not the account code: a hotel maps
    // to 5600 like a restaurant does, and its input tax is claimable.
    const hotel = receipt({ vendorName: 'Protea Hotel Umhlanga' });
    expect(parseReceiptType(hotel)).toBe('travel');
    const journal = buildExpenseJournalFromReceipt(hotel, accountIds);
    expect(journal.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(150);
    expect(journal.lines.find(l => l.accountId === accountIds.expenseAccountId)?.debit).toBe(1000);
  });

  it('balances the denied entry, and the gross equals what left the bank', () => {
    const journal = buildExpenseJournalFromReceipt(receipt(), accountIds);
    const debit = journal.lines.reduce((a, l) => a + l.debit, 0);
    const credit = journal.lines.reduce((a, l) => a + l.credit, 0);
    expect(debit).toBe(credit);
    expect(journal.lines.find(l => l.accountId === accountIds.expenseAccountId)?.debit)
      .toBe(journal.lines.find(l => l.accountId === accountIds.bankAccountId)?.credit);
  });

  it('tags no line as a standard-rated claim once the claim is denied', () => {
    const journal = buildExpenseJournalFromReceipt(receipt(), accountIds);
    expect(journal.lines.every(l => l.vatType === undefined)).toBe(true);
  });

  it('reports the denial to the caller instead of only logging it', () => {
    expect(buildExpenseJournalFromReceipt(receipt(), accountIds).inputVatDenied).toBe(true);
    const office = receipt({ vendorName: 'Waltons Stationery' });
    expect(buildExpenseJournalFromReceipt(office, accountIds).inputVatDenied).toBe(false);
  });

  it('denies the claim when the VAT was derived rather than extracted', () => {
    // subtotal and vatAmount absent: the builder computes 400 + 60 from 460.
    const derived = receipt({ subtotal: null, vatAmount: null, totalAmount: 460 });
    const journal = buildExpenseJournalFromReceipt(derived, accountIds);
    expect(journal.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(0);
    expect(journal.lines.find(l => l.accountId === accountIds.expenseAccountId)?.debit).toBe(460);
  });

  it('denies on the account flag when the merchant regex does not know the vendor', () => {
    // MERCHANT_PATTERNS knows Spur and Nandos, not Tashas. The authoritative
    // input is gl_accounts.vat_input_denied, which the caller resolves.
    const tashas = receipt({ vendorName: 'Tashas Melrose Arch' });
    expect(parseReceiptType(tashas)).toBe('general');

    const unflagged = buildExpenseJournalFromReceipt(tashas, accountIds);
    expect(unflagged.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(150);

    const flagged = buildExpenseJournalFromReceipt(tashas, accountIds, { accountVatDenied: true });
    expect(flagged.inputVatDenied).toBe(true);
    expect(flagged.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(0);
    expect(flagged.lines.find(l => l.accountId === accountIds.expenseAccountId)?.debit).toBe(1150);
  });

  it('keeps the merchant heuristic when the account carries no flag', () => {
    // The two inputs are OR'd: an explicit false on the account must not
    // resurrect the claim on a receipt the merchant map already denied.
    const journal = buildExpenseJournalFromReceipt(receipt(), accountIds, { accountVatDenied: false });
    expect(journal.inputVatDenied).toBe(true);
    expect(journal.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(0);
  });

  it('leaves an unclassifiable merchant claiming its input tax', () => {
    // The denial is a whitelist of one type, not a default: an unmatched
    // merchant keeps the claim rather than silently losing it.
    const unknown = receipt({ vendorName: 'Random Supplier CC' });
    expect(parseReceiptType(unknown)).toBe('general');
    const journal = buildExpenseJournalFromReceipt(unknown, accountIds);
    expect(journal.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.debit).toBe(150);
    expect(journal.lines.find(l => l.accountId === accountIds.expenseAccountId)?.debit).toBe(1000);
    // Tagged, which is what puts the posting routes inside the CI VAT gate.
    expect(journal.lines.find(l => l.accountId === accountIds.vatInputAccountId)?.vatType).toBe('standard');
    expect(journal.lines.find(l => l.accountId === accountIds.expenseAccountId)?.vatType).toBe('standard');
  });
});
