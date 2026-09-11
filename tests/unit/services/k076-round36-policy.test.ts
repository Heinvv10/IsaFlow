/**
 * Round 36 (review of `96ba518e2`, 1H/1M/2L).
 *
 * HIGH-1: the restaurant draft "held for a person" was posted by MCP
 * `post_journal`. One predicate (`mealsVatNeedsAPerson`) now decides the hold
 * for the routes AND every unattended poster (DB side: `k072-meals-held`).
 * MEDIUM-1: a CUSTOMER's `Not VAT registered` in the bill-to block counted as
 * the supplier's, and glued `TotalVAT` / `Std rate 15.00%` escaped the tax net.
 * LOW-1: whole words, but with plurals, possessives and known glued brands.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { mealsVatNeedsAPerson, parseReceiptType } from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const none = (rawText: string) => evidencedVat({ vatAmount: null, rawText });
const BOSMAN = (body: string) => `Bosman Motors\nINVOICE\nInvoice No: 7781\nDate: 2026-05-02\n${body}`;

describe('K-076 r36 MEDIUM-1 — the declaration must be the supplier\'s', () => {
  it('the reviewer\'s shapes: a customer\'s line in the bill-to block evidences nothing', () => {
    expect(none(BOSMAN('Bill To:\nMokoena Trading\nNot VAT registered\nService 869.57\nSubtotal 869.57\nTotalVAT 130.43\nTOTAL 1000.00'))).toBeNull();
    expect(none(BOSMAN('Bill To:\nMokoena Trading\nNot VAT registered\nService 869.57\nSubtotal 869.57\nStd rate 15.00% 130.43\nTOTAL 1000.00'))).toBeNull();
    // With no tax line at all, the customer's line still is not the supplier's.
    expect(none(BOSMAN('Bill To:\nMokoena Trading\nNot VAT registered\nService 1000.00\nTOTAL 1000.00'))).toBeNull();
  });

  it.each(['Sold To:', 'Invoice To:', 'Deliver To:', 'Customer:', 'Ship To', 'Faktuur aan:', 'Klant:'])(
    'a declaration under `%s`, above the total, is refused', (head) => {
      expect(none(BOSMAN(`${head}\nMokoena Trading\nNot VAT registered\nService 1000.00\nTOTAL 1000.00`))).toBeNull();
    });

  it('the supplier\'s header (above the customer block) and footer (below the last total) are the supplier\'s', () => {
    expect(none(`Joe Garden Services\nWe are not VAT registered.\nBill To:\nMokoena Trading\nGarden service 1000.00\nTOTAL 1000.00`)).toBe(0);
    expect(none(`Joe Garden Services\nBill To:\nMokoena Trading\nGarden service 1000.00\nTOTAL 1000.00\nWe are not VAT registered.`)).toBe(0);
    expect(none(`Joe Garden Services\nNot VAT registered\nGarden service 1000.00\nAmount Due 1000.00`)).toBe(0);
  });

  it.each(['TotalVAT 130.43', 'SUBTOTALVAT 130.43', 'SubtotalBTW 130.43', 'TotalTax 130.43', 'Std rate 15.00% 130.43', 'Rate 15,0 %',
    '8TW 130.43', 'V/AT 130.43', 'T.A.X. 130.43'])('a declaration beside `%s` is refused: that line speaks of tax', (line) => {
    expect(none(`Joe Garden Services\nNot VAT registered\nGarden service 1000.00\n${line}\nAmount Due 1000.00`)).toBeNull();
  });

  it.each(['Ref 4123450D00', 'Ref A123450000'])('a declaration beside the OCR-damaged number `%s` is refused', (line) => {
    expect(none(`Joe Garden Services\nNot VAT registered\nGarden service 1000.00\n${line}\nAmount Due 1000.00`)).toBeNull();
  });

  it('the other direction: a word that merely contains `vat` is no tax line', () => {
    expect(none(`Joe Garden Services\nNot VAT registered\nPrivate garden service 1000.00\nRenovation 0.00\nAmount Due 1000.00`)).toBe(0);
  });
});

const slip = (vendorName: string) => ({ vendorName }) as ExtractedDocument;

describe('K-076 r36 LOW-1 — plurals, possessives and glued brands are still the merchant', () => {
  it.each(['Mr Delivery', 'MR DELIVERY Sandton', 'Wimpys', 'Spurs Steak Ranch', 'CoffeeShop Linden', 'Coffee Shop', "McDonald's", "Nando's"])(
    '`%s` is meals', (vendor) => {
      expect(parseReceiptType(slip(vendor))).toBe('meals');
    });

  it.each(['Sparks Electrical', 'Sparkle Valet', 'Drain Masters', 'Spurway Steel', 'Mr Doors Brits'])('`%s` is still not a merchant it contains', (vendor) => {
    expect(parseReceiptType(slip(vendor))).toBe('general');
  });

  it('`Mr Delivery` claiming VAT is held for a person, as `Mr D Food` is', () => {
    expect(mealsVatNeedsAPerson('Mr Delivery', 130.43)).toBe(true);
    expect(mealsVatNeedsAPerson('Mr D Food', 130.43)).toBe(true);
  });
});
