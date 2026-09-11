/**
 * Round 35 (review of `f197e7481`, 1H/1M/0L).
 *
 * HIGH-1: the phrases that ALLOW "no VAT read = 0" matched mid-sentence, so an
 * item footnote (`VAT is not applicable on the call-out fee`) on a page that
 * charges a VAT the reader missed evidenced none. Now only the SUPPLIER's own
 * registration status counts, as a whole line, and any OTHER tax mention or
 * VAT-number-shaped token refuses (DB side: `k072-vat-declaration`).
 * MEDIUM-1: the receipt builder folded a read VAT into the expense because the
 * vendor NAME matched a meals pattern (`spur` in `Spurway Steel`). Denial is
 * now the account's alone, the merchant patterns match whole words, and a
 * meals merchant on an account that does not deny is not posted unattended
 * (DB side: `k072-receipt-entertainment-vat`).
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';
import {
  buildExpenseJournalFromReceipt,
  mealsOnClaimingAccount,
  parseReceiptType,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const none = (rawText: string) => evidencedVat({ vatAmount: null, rawText });
const JOE = (line: string, extra = '') => `Joe Garden Services\n${line}\nGarden service 1000.00\n${extra}Amount Due 1000.00`;

describe('K-076 r35 HIGH-1 — only the supplier declares itself, as a line of its own', () => {
  it('the reviewer\'s three DB shapes evidence nothing', () => {
    expect(none('Bosman Motors\nINVOICE\nVAT No: 4I23450000\nService 60 000km 3000.00\nCall-out fee 450.00\nTOTAL 3450.00\n'
      + 'VAT INCL 391.30\nPlease note: VAT is not applicable on the call-out fee')).toBeNull();
    expect(none('Brits Bouwerk\nINVOICE\nBricks 1000 x 2.30 2300.00\nTOTAL 2300.00\nVAT included 300.00\n'
      + 'Non-VAT registered customers pay the full amount')).toBeNull();
    expect(none('Engen Linden\nTAX INVOICE\nDiesel 40.00L 1000.00\nOil 5W30 1L 230.00\nTOTAL 1230.00\nVAT INCL 30.00\n'
      + 'Fuel is zero rated - VAT not applicable on fuel')).toBeNull();
  });

  it.each(['VAT is not applicable on the call-out fee', 'VAT not applicable on fuel', 'VAT not applicable to zero-rated goods',
    'VAT not applicable', 'No VAT', 'NO VAT CHARGED', 'Geen BTW', 'Customer: not VAT registered', 'Non-VAT registered customers pay the full amount',
    'We are not VAT registered, prices are final', 'Non-VAT registered'])('`%s` is not a supplier declaration', (line) => {
    expect(none(JOE(line))).toBeNull();
  });

  it('an OCR-split table cell is not one either: `Deposit` / `No VAT`', () => {
    expect(none('Joe Garden Services\nDeposit\nNo VAT\nGarden service 1000.00\nAmount Due 1000.00')).toBeNull();
  });

  it.each(['We are not VAT registered.', 'Ons is nie BTW-geregistreer nie', 'This supplier is not registered for VAT',
    'Not a VAT registered vendor', 'NOT VAT REGISTERED', 'Non-VAT vendor'])('`%s` on an otherwise tax-free page evidences 0', (line) => {
    expect(none(JOE(line))).toBe(0);
  });

  it.each(['VAl 30.00\n', 'Prices incl. everything\n', 'Tax 30.00\n', 'Rate 15%\n', 'B.T.W. 30.00\n', 'Includes 30.00\n'])(
    'a declaration beside any other tax mention (`%s`) refuses', (extra) => {
      expect(none(JOE('Not VAT registered', extra))).toBeNull();
    });

  it.each(['VAT No 4123450000', 'Reg 4I23450000', 'Ref 4123  450000', 'Ref 412345000', 'Ref 4123/450/000', 'Ref 4O2345678l'])(
    'a declaration beside a VAT-number-shaped token (`%s`) refuses', (extra) => {
      expect(none(JOE('Not VAT registered', `${extra}\n`))).toBeNull();
    });

  it('the other direction: ordinary figures are not VAT numbers', () => {
    expect(none(JOE('Not VAT registered', 'Invoice 4500\nPhone 011 486 1234\nFNB 62812345678\n'))).toBe(0);
  });
});

const slip = (vendorName: string): ExtractedDocument => ({
  documentType: 'receipt', vendorName, vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null, customerName: null,
  customerVatNumber: null, date: '2026-05-06', dueDate: null, paymentTerms: null, referenceNumber: 'R1', purchaseOrderRef: null,
  currency: 'ZAR', subtotal: 869.57, vatAmount: 130.43, vatRate: 15, totalAmount: 1000, lineItems: [], rawText: '', confidence: 0.99,
  warnings: [], extractionMethod: 'vlm',
});
const IDS = { expenseAccountId: 'exp', vatInputAccountId: 'vat', bankAccountId: 'bank' };

describe('K-076 r35 MEDIUM-1 — denial is the account\'s; merchant names are whole words', () => {
  it.each([['Spurway Steel', 'general'], ['Mr Doors Brits', 'general'], ['Sparrow Hardware', 'general'], ['Rainbow Chicken', 'general'],
    ['Spur Steak Ranches Rosebank', 'meals'], ['SPUR STEAK RANCH', 'meals'], ['Mr D Food', 'meals'], ['Uber Eats', 'meals'],
    ['Coffee Couture', 'meals'], ["Nando's Menlyn", 'meals'], ['KwikSpar Linden', 'general'], ['Engen Linden', 'fuel']])(
    '`%s` is %s', (vendor, type) => {
      expect(parseReceiptType(slip(vendor))).toBe(type);
    });

  it('a read VAT is folded into the expense only when the ACCOUNT denies it, whatever the vendor', () => {
    for (const vendor of ['Spur Steak Ranches Rosebank', 'Spurway Steel']) {
      const claimed = buildExpenseJournalFromReceipt(slip(vendor), IDS);
      expect(claimed.lines.find((l) => l.accountId === 'vat')!.debit, vendor).toBe(130.43);
      const denied = buildExpenseJournalFromReceipt(slip(vendor), IDS, { accountVatDenied: true });
      expect(denied.lines.find((l) => l.accountId === 'vat')!.debit, vendor).toBe(0);
      expect(denied.lines.find((l) => l.accountId === 'exp')!.debit, vendor).toBe(1000);
    }
  });

  it('a meals merchant on an account that does not deny is for a person; on one that denies, or any other vendor, it is not', () => {
    expect(mealsOnClaimingAccount(slip('Spur Steak Ranches Rosebank'), false)).toBe(true);
    expect(mealsOnClaimingAccount(slip('Spur Steak Ranches Rosebank'), true)).toBe(false);
    expect(mealsOnClaimingAccount(slip('Spurway Steel'), false)).toBe(false);
  });
});
