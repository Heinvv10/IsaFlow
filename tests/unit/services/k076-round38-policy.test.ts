/**
 * Round 38 (review of `7de7192e9`, 0H/0M/2L).
 *
 * LOW-1: a customer's `Not VAT registered` counted as the supplier's under 26
 * common heads the list lacked. Inverted: a declaration counts only in the
 * supplier's own region — above the first line that opens ANY other block (a
 * label, a customer head, an address) or below the last total with no block
 * between. And the tax net learns `WAT`, `\/AT`, `Tx`, `V-A-T`, `V:A:T`,
 * `Value Added`. The reviewer's stacked mixed-rate pages are refused (DB side:
 * `k072-vat-declaration`). LOW-2 is DB-only (`k072-meals-held`).
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

const ev = (rawText: string, totalAmount = 1000) => evidencedVat({ vatAmount: null, rawText, totalAmount, subtotal: null });

describe('K-076 r38 LOW-1 — a declaration counts only in the supplier\'s own region', () => {
  it.each(['Billing Address:', 'Billing Details', 'Billing:', 'Invoice Address:', 'Postal Address:', 'Physical Address:', 'Recipient:',
    'Purchaser:', 'Consignee:', 'Payer:', 'Cust:', 'Cust. No: 1234', 'Name:', 'Company:', 'Your details:', 'Afleweringsadres:',
    'Posadres:', 'Rekening:', 'Debiteur:', 'A/C:', 'Acc No: 77', 'For:', 'Prepared for:', 'Issued to:', 'Supplied to:', 'Invoice for:'])(
    'the reviewer\'s head `%s`: the customer\'s declaration under it evidences nothing', (head) => {
      expect(ev(`Joe Garden Services\nINVOICE\n${head}\nMokoena Trading\nNot VAT registered\nGarden service 1000.00\nTOTAL 1000.00`)).toBeNull();
    });

  it('the supplier\'s own region still counts: directly under its name, or in the footer below the total', () => {
    expect(ev('Joe Garden Services\nNot VAT registered\nBilling Address:\nMokoena Trading\nGarden service 1000.00\nTOTAL 1000.00')).toBe(0);
    expect(ev('Joe Garden Services\nINVOICE\nWe are not VAT registered.\nGarden service 1000.00\nAmount Due 1000.00')).toBe(0);
    expect(ev('Mama Thandi Catering\nINVOICE\nInvoice No: 88\nPlatters x10 1000.00\nTotal 1000.00\nNot VAT registered')).toBe(0);
  });

  it('fails closed where it cannot tell: below an address or a label, or a footer that restarts a block', () => {
    expect(ev('Joe Garden Services\n12 Oak Ave, Linden\nNot VAT registered\nGarden service 1000.00\nTOTAL 1000.00')).toBeNull();
    expect(ev('Joe Garden Services\nInvoice No: 12\nNot VAT registered\nGarden service 1000.00\nTOTAL 1000.00')).toBeNull();
    expect(ev('Joe Garden Services\nGarden service 1000.00\nTOTAL 1000.00\nDeliver to:\nMokoena\nNot VAT registered')).toBeNull();
  });

  it.each(['WAT 13.00', '\\/AT 13.00', 'Tx 13.00', 'TX 13.00', 'V-A-T 13.00', 'V_A_T 13.00', 'V:A:T 13.00', 'Value Added 13.00'])(
    'a supplier\'s declaration beside `%s` is refused: that line speaks of tax', (line) => {
      expect(ev(`Joe Garden Services\nWe are not VAT registered.\nGarden service 987.00\n${line}\nAmount Due 1000.00`)).toBeNull();
    });

  it('the other direction: Afrikaans `wat` ("which") in lower case is no tax word', () => {
    expect(ev('Joe se Tuindienste\nNie BTW-geregistreer nie\nTuindiens wat in Mei gedoen is 1000.00\nBedrag Verskuldig 1000.00')).toBe(0);
  });

  it('the reviewer\'s stacked mixed-rate pages are refused', () => {
    const page = (head: string, tax: string) => `Bosman Foods\nINVOICE\n${head}\nMokoena Trading\nNot VAT registered\n`
      + `Cooldrinks 869.57\nBrown bread 210.00\nSubtotal 1079.57\n${tax}\nTOTAL 1210.00`;
    expect(ev(page('Billing Address:', 'WAT 130.43'), 1210)).toBeNull();
    expect(ev(page('Billing Address:', '\\/AT 130.43'), 1210)).toBeNull();
    expect(ev(page('Postal Address:', 'Tx 130.43'), 1210)).toBeNull();
  });
});
