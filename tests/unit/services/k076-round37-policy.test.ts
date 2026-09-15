/**
 * Round 37 (review of `c123278f9`, 0H/2M/2L).
 *
 * MEDIUM-1: tokenisation — customer-block heads with any separator (`Bill-To:`,
 * `To:`, `Attn:`), a block that restarts below the totals, and tax words glued
 * on the right (`VATAMT`, `TaxAmt`, `VATINCL`). Plus a STRUCTURAL tripwire that
 * needs no word: a printed figure equal to total × 15/115, or 15% of the total
 * or the net, means "no VAT read" never counts as none.
 * MEDIUM-2: the meals hold is one function over the SAME inputs everywhere; a
 * person's correction of the vendor comes first.
 * LOW-2: only the meals names take a plural.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { mapMerchantToExpenseAccount, mealsVatNeedsAPerson, parseReceiptType } from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const ev = (rawText: string, totalAmount: number | null = 1000, subtotal: number | null = null) =>
  evidencedVat({ vatAmount: null, rawText, totalAmount, subtotal });
const BOSMAN = (head: string, taxLine: string) => `Bosman Motors\nINVOICE\nInvoice No: 7781\n${head}\nMokoena Trading\nNot VAT registered\n`
  + `Service 60 000km 869.57\nSubtotal 869.57\n${taxLine}\nTOTAL 1000.00`;

describe('K-076 r37 MEDIUM-1 — tokenisation', () => {
  it.each(['Bill-To:', 'BILL-TO', 'BillTo:', 'Invoice-To:', 'Ship-To:', 'Deliver-To:', 'Sold-To:', 'To:', 'Attn:', 'Account:', 'Debtor:',
    'Buyer:', 'Kliënt:'])('a customer\'s declaration under `%s` is not the supplier\'s', (head) => {
    expect(ev(`Joe Garden Services\nINVOICE\n${head}\nMokoena Trading\nNot VAT registered\nGarden service 1000.00\nTOTAL 1000.00`)).toBeNull();
  });

  it('a customer block that restarts below the totals is still the customer\'s', () => {
    for (const head of ['Customer details:', 'Deliver To:']) {
      expect(ev(`Joe Garden Services\nGarden service 1000.00\nTOTAL 1000.00\n${head}\nMokoena Trading\nNot VAT registered`)).toBeNull();
    }
  });

  it.each(['VATAMT 13.00', 'VATAmt 13.00', 'TaxAmt 13.00', 'VATINCL 13.00', 'BTWbedrag 13.00', 'VATR13.00', 'TotalVAT 13.00'])(
    'a declaration beside `%s` (glued, and not VAT-shaped) is refused: the word speaks of tax', (line) => {
      expect(ev(`Joe Garden Services\nWe are not VAT registered.\nGarden service 1000.00\n${line}\nAmount Due 1000.00`)).toBeNull();
    });

  it('the reviewer\'s shapes', () => {
    expect(ev(BOSMAN('Bill-To:', 'VATAMT 130.43'))).toBeNull();
    expect(ev(BOSMAN('Deliver-To:', 'TaxAmt 130.43'))).toBeNull();
    expect(ev(BOSMAN('To:', 'VATINCL 130.43'))).toBeNull();
  });

  it('the other direction: ordinary words that contain the letters, and a supplier\'s own header, still evidence 0', () => {
    expect(ev('Joe Garden Services\nWe are not VAT registered.\nPrivate garden renovation 1000.00\nTaxi 0.00\nAmount Due 1000.00')).toBe(0);
    expect(ev('Joe Garden Services\nNot VAT registered\nBill To:\nMokoena Trading\nGarden service 1000.00\nTOTAL 1000.00')).toBe(0);
  });
});

describe('K-076 r37 MEDIUM-1 — the structural tripwire: a VAT-shaped figure, whatever its label', () => {
  const quiet = (line: string) => `Joe Garden Services\nWe are not VAT registered.\nGarden service 869.57\n${line}\nAmount Due 1000.00`;
  it.each([['total × 15/115', 'Extras 130.43', 1000, null], ['15% of the total', 'Call-out 150.00', 1000, null],
    ['15% of the net', 'Sundries 130.44', 1000, 869.57]] as const)('%s printed (`%s`) refuses', (_why, line, total, net) => {
    expect(ev(quiet(line), total, net)).toBeNull();
  });
  it('within a cent either way; two cents away is not VAT-shaped', () => {
    expect(ev(quiet('Extras 130.42'))).toBeNull();
    expect(ev(quiet('Extras 130.45'))).toBe(0);
  });
});

describe('K-076 r37 MEDIUM-2 — one hold, the same inputs, the correction first', () => {
  it('a person\'s correction decides: `W1MPY` corrected to Wimpy is held; Wimpy corrected to Brits Steel is not', () => {
    expect(mealsVatNeedsAPerson({ confirmed: 'Wimpy Linden', extracted: 'W1MPY LINDEN' }, 130.43)).toBe(true);
    expect(mealsVatNeedsAPerson({ confirmed: 'Mugg & Bean Rosebank', extracted: null }, 130.43)).toBe(true);
    expect(mealsVatNeedsAPerson({ confirmed: 'Brits Steel', extracted: 'Wimpy Linden' }, 130.43)).toBe(false);
    expect(mealsVatNeedsAPerson({ confirmed: '  ', extracted: 'Wimpy Linden' }, 130.43)).toBe(true);
  });
});

const ACCOUNTS = [{ id: '5100', code: '5100', name: 'Office' }, { id: '5400', code: '5400', name: 'Fuel' }, { id: '5600', code: '5600', name: 'Admin' }];

describe('K-076 r37 LOW-2 — only the meals names take a plural', () => {
  it.each(['Rains Plumbing', 'Spars Engineering', 'Totals Hardware', 'Games Workshop', 'Shells Seafood', 'Lodges Ltd',
    'Bolts & Nuts Hardware', 'Incredibles'])('`%s` maps to no merchant account', (vendor) => {
    expect(mapMerchantToExpenseAccount(vendor, ACCOUNTS)).toBeNull();
  });
  it.each(['Wimpys', 'Spurs Steak Ranch', "Nando's", 'Rain', 'SPAR Linden', 'Total Garage'])('`%s` still maps', (vendor) => {
    expect(mapMerchantToExpenseAccount(vendor, ACCOUNTS)).not.toBeNull();
  });
  it('`Totals Hardware` is not fuel', () => {
    expect(parseReceiptType({ vendorName: 'Totals Hardware' } as ExtractedDocument)).toBe('general');
  });
});
