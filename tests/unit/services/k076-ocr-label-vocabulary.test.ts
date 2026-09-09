import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';

/**
 * THE LABEL VOCABULARY, as a table.
 *
 * Round 3 of the blind review found the SAME defect under two more labels after
 * it had been declared closed for `Sub Total`: `Ex VAT` read the net as the tax
 * (an R1 000 input-tax claim on an R1 150 invoice, balanced and auto-posted),
 * and `Nett Total` read the net as the payable total. Both were live because
 * the guard and the pattern were fixed one spelling at a time.
 *
 * So the vocabulary is a TABLE, not a set of hand-written cases: every label
 * that means "this is not the amount payable" is asserted to be (a) refused as
 * the total, (b) read as the net, and (c) never read as the tax. Adding a
 * spelling is one row here plus one alternative in `ocrAmountPatterns`.
 */
describe('K-076 every NET label, on a document that prints the VAT', () => {
  it.each([
    ['Sub Total', 'Sub Total'],
    ['Subtotal', 'Subtotal'],
    ['Sub-Total', 'Sub-Total'],
    ['Sub  Total (two spaces)', 'Sub  Total'],
    ['Sub.Total', 'Sub.Total'],
    ['Sub_Total', 'Sub_Total'],
    ['Sub/Total', 'Sub/Total'],
    ['S/Total', 'S/Total'],
    ['S.Total', 'S.Total'],
    ['SubTotal (joined)', 'SubTotal'],
    ['SUB - TOTAL', 'SUB - TOTAL'],
    ['Nett Total', 'Nett Total'],
    ['Net Total', 'Net Total'],
    ['NETT TOTAL', 'NETT TOTAL'],
    ['Nett Amount', 'Nett Amount'],
    ['Net Value', 'Net Value'],
    ['Nett', 'Nett'],
    ['Goods Value', 'Goods Value'],
    ['Total Excl VAT', 'Total Excl VAT'],
    ['Total Excl. VAT', 'Total Excl. VAT'],
    ['Total Excluding VAT', 'Total Excluding VAT'],
    ['Amount Excl VAT', 'Amount Excl VAT'],
    ['Price Ex VAT', 'Price Ex VAT'],
    ['Price Ex. VAT', 'Price Ex. VAT'],
    ['Price ExVAT', 'Price ExVAT'],
    ['Amount Exc VAT', 'Amount Exc VAT'],
    ['Excluding VAT', 'Excluding VAT'],
    ['Excl. Tax', 'Excl. Tax'],
    ['Ex VAT', 'Ex VAT'],
    ['Total Excl. of VAT', 'Total Excl. of VAT'],
  ])('%s is the net, never the total and never the tax', (_name, label) => {
    const result = extractAmounts(`${label} 1000.00\nVAT 150.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });

  // The worst shape: with no VAT line printed the builder derives 15% of
  // whatever it was handed, so a net read as the total BALANCES at the wrong
  // figure, clears the pre-check, passes the auto-post gate and posts
  // unattended — the expense R150 short and a bank credit that can never match
  // the R1 150 the statement shows.
  it.each([
    ['Sub Total', 'Sub Total'],
    ['Sub.Total', 'Sub.Total'],
    ['S/Total', 'S/Total'],
    ['Nett Total', 'Nett Total'],
    ['Net Total', 'Net Total'],
    ['NETT TOTAL', 'NETT TOTAL'],
  ])('%s with no VAT line printed still leaves the payable total at 1150', (_name, label) => {
    const result = extractAmounts(`${label} 1000.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
  });
});

describe('K-076 an exclusive label with NO separate VAT line printed', () => {
  // The shape that has no arithmetic to fall back on. Where a VAT line IS
  // printed, `extractVatAmount` can pick the tax out of two candidates because
  // subtotal + candidate === total; with only the net and the total on the
  // document there is one candidate, and the label guard is the only thing
  // between the reader and reporting the NET as the tax — an R1 000 input-tax
  // claim on an R1 150 invoice, which is exactly what was measured.
  it.each([
    ['Price Ex VAT', 'Price Ex VAT'],
    ['Price Ex. VAT', 'Price Ex. VAT'],
    ['Price ExVAT', 'Price ExVAT'],
    ['Amount Exc VAT', 'Amount Exc VAT'],
    ['Amount Excl VAT', 'Amount Excl VAT'],
    ['Total Excluding VAT', 'Total Excluding VAT'],
    ['Excl. Tax', 'Excl. Tax'],
  ])('%s is not read as the tax', (_name, label) => {
    const result = extractAmounts(`${label} 1000.00\nTotal Due 1150.00`);
    expect(result.vatAmount).toBeNull();
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1150);
  });
});

describe('K-076 every PAYABLE label is read as the total', () => {
  it.each([
    ['Total', 'Total 1150.00'],
    ['Total Due', 'Total Due 1150.00'],
    ['Total Amount', 'Total Amount 1150.00'],
    ['Total Payable', 'Total Payable 1150.00'],
    ['Grand Total', 'Grand Total 1150.00'],
    ['Invoice Total', 'Invoice Total 1150.00'],
    ['Amount Due', 'Amount Due 1150.00'],
    ['Amount Owing', 'Amount Owing 1150.00'],
    ['Balance Due', 'Balance Due 1150.00'],
    ['Payable', 'Payable 1150.00'],
    ['Total Incl VAT', 'Total Incl VAT 1150.00'],
    ['Total Inc VAT', 'Total Inc VAT 1150.00'],
    ['Total Incl. VAT', 'Total Incl. VAT 1150.00'],
    ['Total Including VAT', 'Total Including VAT 1150.00'],
    ['Amount Including V.A.T.', 'Amount Including V.A.T. 1150.00'],
    ['Total Incl Tax', 'Total Incl Tax 1150.00'],
  ])('%s', (_name, text) => {
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });

  // The mirror of the guard: it must reject net labels WITHOUT swallowing an
  // ordinary word that merely ends in the same letters.
  it.each([
    ['Sales Total', 'Sales Total 1150.00'],
    ['Cash Sales Total', 'Cash Sales Total 1150.00'],
    ['Items Total', 'Items Total 1150.00'],
  ])('%s is still a total — the guard reads words, not letters', (_name, text) => {
    expect(extractAmounts(text).totalAmount).toBe(1150);
  });

  it('does not read an Accounts Payable heading as the amount payable', () => {
    expect(extractAmounts('Accounts Payable 9999.00\nTotal Due 1150.00').totalAmount).toBe(1150);
  });
});

describe('K-076 every TAX label is read as the tax', () => {
  it.each([
    ['VAT', 'VAT 150.00'],
    ['VAT:', 'VAT: 150.00'],
    ['V.A.T.', 'V.A.T. 150.00'],
    ['VAT @ 15%', 'VAT @ 15% 150.00'],
    ['VAT (15%)', 'VAT (15%) 150.00'],
    ['VAT 15%', 'VAT 15% 150.00'],
    ['Tax', 'Tax 150.00'],
    ['Tax Amount', 'Tax Amount 150.00'],
    ['Output Tax', 'Output Tax 150.00'],
    ['Input Tax', 'Input Tax 150.00'],
    ['VAT R', 'VAT R 150.00'],
  ])('%s', (_name, line) => {
    const result = extractAmounts(`Sub Total 1000.00\n${line}\nTotal Due 1150.00`);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1150);
  });

  it('does not treat a word merely ENDING in "ex" as an exclusive marker', () => {
    // `Ex`/`In` are real abbreviations, so the guard has to admit them — but
    // only as words. Without the inner \b, "Index VAT" lost the tax entirely.
    expect(extractAmounts('Index VAT 150.00\nTotal Due 1150.00').vatAmount).toBe(150);
  });
});

describe('K-076 realistic South African layouts foot', () => {
  it('a VAT-inclusive till slip', () => {
    const text = [
      'CHECKERS HYPER', 'VAT REG 4123456789',
      'Milk 1L        20.00', 'Brown Bread    15.00',
      'TOTAL          1150.00', 'VAT @ 15%       150.00',
      'CASH           1200.00', 'CHANGE           50.00',
    ].join('\n');
    const result = extractAmounts(text);
    expect(result.totalAmount).toBe(1150);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1000);
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });

  it('a zero-rated slip states its VAT as zero and invents no claim', () => {
    const text = 'Brown Bread 500.00\nMaize Meal 500.00\nVAT 0.00\nTotal Due 1000.00';
    const result = extractAmounts(text);
    expect(result.vatAmount).toBe(0);
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1000);
  });

  it('a hotel bill carrying both a Tax column and a VAT column', () => {
    const text = 'Room Charge 1000.00\nTourism Levy Tax 12.00\nVAT @ 15% 150.00\nTotal Due 1162.00';
    const result = extractAmounts(text);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1012);
    expect(result.totalAmount).toBe(1162);
    expect(result.subtotal! + result.vatAmount!).toBe(result.totalAmount);
  });
});
