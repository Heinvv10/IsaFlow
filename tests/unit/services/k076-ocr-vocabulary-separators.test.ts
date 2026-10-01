import { describe, expect, it } from 'vitest';
import { SUMMARY_LINE_START } from '@/modules/accounting/services/core/ocrAmountPatterns';
import { extractAmounts, extractLineItems } from '@/modules/accounting/services/core/ocrExtractionService';

/**
 * ONE MEMBER OF THE VOCABULARY, ONE TEST — the separator included.
 *
 * `ocrAmountPatterns` is built from shared parts (`SEP`, `ABBREV_TAIL`,
 * `EXCL`/`INCL`, `NET_LABEL`, `NET_PREFIX`) so that a guard and the pattern
 * behind it cannot drift. Two members bypassed them by spelling a fragment of
 * their own, and both reproduced a money defect the shared part exists to
 * prevent:
 *
 *   - `NET_LABEL` spelled `S[./]` while `SEP` is `[\s._/-]*`, so `S-Total
 *     1000.00 / VAT 150.00 / Total Due 1150.00` measured total=1000,
 *     subtotal=850, vat=150 — balanced, auto-posted, bank credited R150 short.
 *   - `NOT_A_TAX_LABEL` spelled `[\s-]*`, so `Total Excl_VAT 1000.00 / Total
 *     Due 1150.00` measured vat=1000 — an R1 000 input-tax claim on an R1 150
 *     invoice, the net read as the tax.
 *
 * So each table below walks ONE member across EVERY separator `SEP` admits.
 * A member that re-spells a shared part passes its own row and fails a sibling
 * separator, which is the only signal that distinguishes the two.
 */

/** Every separator in `SEP`, plus the joined form its `*` subsumes. */
const SEPARATORS = [' ', '-', '_', '.', '/', '  ', ''] as const;
const sepName = (s: string) => (s === '' ? '(joined)' : JSON.stringify(s));

describe('K-076 SEP × NET_LABEL — the abbreviated S-Total, every spelling', () => {
  it.each(SEPARATORS)('S%sTotal is the net, never the payable total', (sep) => {
    const result = extractAmounts(`Widget 1000.00\nS${sep}Total 1000.00\nVAT 150.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBe(150);
  });

  // The shape with no VAT line: nothing to reconcile against, so a net read as
  // the total balances at the wrong figure and posts unattended.
  it.each(SEPARATORS)('S%sTotal with no VAT line still leaves the payable at 1150', (sep) => {
    const result = extractAmounts(`S${sep}Total 1000.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
  });

  // Both directions: the widened guard must not swallow an ordinary word that
  // merely starts with S.
  it.each(['Sales Total 1150.00', 'Cash Sales Total 1150.00', 'Items Total 1150.00', 'Services Total 1150.00'])(
    '%s is still the payable total',
    (text) => { expect(extractAmounts(text).totalAmount).toBe(1150); },
  );
});

describe('K-076 SEP × NOT_A_TAX_LABEL — the exclusive marker, every separator', () => {
  it.each(SEPARATORS)('Total Excl%sVAT is the net, never the tax', (sep) => {
    const result = extractAmounts(`Total Excl${sep}VAT 1000.00\nTotal Due 1150.00`);
    expect(result.totalAmount).toBe(1150);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBeNull();
  });

  it('Index VAT is still the tax — the guard reads words, not letters', () => {
    expect(extractAmounts('Index VAT 150.00\nTotal Due 1150.00').vatAmount).toBe(150);
  });
});

describe('K-076 SEP × INCL — the inclusive marker has a pattern, not just a guard', () => {
  // MEDIUM-3: `NOT_A_TAX_LABEL` refused `Incl VAT` as the tax with no prefix
  // required, while `TOTAL_PATTERNS` read it back only behind a mandatory
  // prefix and `SUMMARY_LINE_START` had no branch at all. Measured, a bare
  // `Incl VAT 1150.00` came back total/subtotal/vat all null — a 400 on a
  // legible slip — and the line was collected as a phantom R1 150 expense item.
  it.each(SEPARATORS)('a bare Incl%sVAT line is the payable total', (sep) => {
    const result = extractAmounts(`Widget 1000.00\nIncl${sep}VAT 1150.00`);
    expect(result.totalAmount).toBe(1150);
  });

  it.each(['Incl VAT', 'Inc VAT', 'In VAT', 'Incl. VAT', 'Including VAT', 'Incl Tax'])(
    'a bare "%s" line terminates the item list',
    (label) => {
      expect(SUMMARY_LINE_START.test(`${label} 1150.00`)).toBe(true);
      expect(extractLineItems(['Widget A  1  100.00  100.00', `${label}  1150.00`])).toHaveLength(1);
    },
  );

  it.each(SEPARATORS)('Total Incl%sVAT is still the payable total', (sep) => {
    expect(extractAmounts(`Widget 1000.00\nTotal Incl${sep}VAT 1150.00`).totalAmount).toBe(1150);
  });
});

describe('K-076 ABBREV_TAIL — the exclusive marker standing without a tax word', () => {
  // `SUBTOTAL_PATTERNS[2]` spelled its own `Exc(?:l(?:uding)?)?\.?`. Narrower
  // than `EXCL` on purpose — with no tax word to corroborate it, the bare `Ex`
  // is too common a fragment — but spelled by hand it was a second copy of the
  // stem. It is now `EXCL_LONG`, built from the same `ABBREV_TAIL`.
  it.each(['Exc', 'Excl', 'Excluding'])('Total %s 1000.00 is the net', (marker) => {
    const result = extractAmounts(`Total ${marker} 1000.00\nTotal Due 1150.00`);
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1150);
  });

  it('the bare two-letter Ex with no tax word is deliberately NOT read as the net', () => {
    expect(extractAmounts('Total Ex 1000.00\nTotal Due 1150.00').subtotal).toBeNull();
  });

  it.each(SEPARATORS)('Total%sExcl 1000.00 is the net', (sep) => {
    expect(extractAmounts(`Total${sep}Excl 1000.00\nTotal Due 1150.00`).subtotal).toBe(1000);
  });
});

describe('K-076 NET_PREFIX is the net vocabulary, not one spelling of it', () => {
  it.each(['Sub-Total', 'Sub Total', 'S/Total', 'Nett Total', 'Net', 'Goods Value', 'Amount', 'Price', 'Value'])(
    '"%s Excl VAT 1000.00" is the net',
    (prefix) => {
      const result = extractAmounts(`${prefix} Excl VAT 1000.00\nTotal Due 1150.00`);
      expect(result.subtotal).toBe(1000);
      expect(result.totalAmount).toBe(1150);
    },
  );

  // WITH NO TAX WORD — the shape `SUBTOTAL_PATTERNS[2]` reads, and the only one
  // where NET_PREFIX is load-bearing. The table above is not: pattern [1] makes
  // the prefix OPTIONAL, so `Nett Total Excl VAT 1000.00` is read by its bare
  // `Excl VAT` branch whatever NET_PREFIX contains, and reverting NET_PREFIX to
  // the hand-spelled `Sub${SEP}Total` left every row of it green.
  //
  // Even here most rows survive that revert, and knowing WHY is the point:
  // `Total` and `Value` are members of NET_PREFIX in their own right, so
  // `S/Total Excl`, `Nett Total Excl` and `Goods Value Excl` all still match on
  // their LAST word. `Nett Excl` is the row with no such fallback, and it is
  // what turns this table from coverage into a mutation kill — measured, it is
  // the one assertion that goes red when NET_PREFIX stops being NET_LABEL.
  it.each(['Sub-Total', 'Sub Total', 'S/Total', 'S-Total', 'Nett Total', 'Nett', 'Goods Value', 'Amount', 'Price', 'Value'])(
    '"%s Excl 1000.00" — no tax word — is the net',
    (prefix) => {
      const result = extractAmounts(`${prefix} Excl 1000.00\nTotal Due 1150.00`);
      expect(result.subtotal).toBe(1000);
      expect(result.totalAmount).toBe(1150);
    },
  );

  it.each(['Sub-Total', 'S/Total', 'Nett Total', 'Goods Value'])(
    '"%s Excl" terminates the item list',
    (prefix) => {
      const line = `${prefix} Excl  1000.00`;
      expect(SUMMARY_LINE_START.test(line)).toBe(true);
      expect(extractLineItems(['Widget A  1  100.00  100.00', line])).toHaveLength(1);
    },
  );
});

describe('K-076 SEP × the payable labels', () => {
  it.each(SEPARATORS)('Amount%sDue is the payable total', (sep) => {
    expect(extractAmounts(`Widget 1000.00\nAmount${sep}Due 1150.00`).totalAmount).toBe(1150);
  });

  it.each(SEPARATORS)('Balance%sDue is the payable total', (sep) => {
    expect(extractAmounts(`Widget 1000.00\nBalance${sep}Due 1150.00`).totalAmount).toBe(1150);
  });

  it.each(SEPARATORS)('Grand%sTotal is the payable total', (sep) => {
    expect(extractAmounts(`Widget 1000.00\nGrand${sep}Total 1150.00`).totalAmount).toBe(1150);
  });

  it.each(SEPARATORS)('an Accounts%sPayable heading is not the amount payable', (sep) => {
    // The AP control account on a statement letterhead, which is not what the
    // document is asking to be paid.
    expect(extractAmounts(`Accounts${sep}Payable 9999.00`).totalAmount).toBeNull();
  });
});

describe('K-076 SEP × the tax labels', () => {
  it.each(SEPARATORS)('Input%sTax is the tax', (sep) => {
    const result = extractAmounts(`Sub Total 1000.00\nInput${sep}Tax 150.00\nTotal Due 1150.00`);
    expect(result.vatAmount).toBe(150);
    expect(result.subtotal).toBe(1000);
    expect(result.totalAmount).toBe(1150);
  });
});

describe('K-076 SUMMARY_LINE_START stops at summaries and nowhere else', () => {
  it.each([
    ['Sub Total', 'Sub Total  1000.00'],
    ['S-Total', 'S-Total  1000.00'],
    ['Nett Total', 'Nett Total  1000.00'],
    ['Goods Value', 'Goods Value  1000.00'],
    ['Total Due', 'Total Due  1150.00'],
    ['Grand.Total', 'Grand.Total  1150.00'],
    ['Amount-Due', 'Amount-Due  1150.00'],
    ['VAT', 'VAT  150.00'],
    ['Input Tax', 'Input Tax  150.00'],
    ['Excl VAT', 'Excl VAT  1000.00'],
    ['Total Excl VAT', 'Total Excl VAT  1000.00'],
    ['Total Excl', 'Total Excl  1000.00'],
    ['Incl VAT', 'Incl VAT  1150.00'],
  ])('%s terminates the item list', (_name, line) => {
    expect(SUMMARY_LINE_START.test(line)).toBe(true);
    expect(extractLineItems(['Widget A  1  100.00  100.00', line])).toHaveLength(1);
  });

  // Both directions. A terminator wider than the vocabulary silently DROPS a
  // real expense line, which understates the expense without warning anyone.
  it.each([
    ['Taxi fare', 'Taxi fare  50.00'],
    ['Exclusive of delivery', 'Exclusive of delivery  50.00'],
    ['Included services', 'Included services  50.00'],
    ['Sales commission', 'Sales commission  50.00'],
  ])('%s is an item, not a summary', (_name, line) => {
    expect(SUMMARY_LINE_START.test(line)).toBe(false);
    expect(extractLineItems(['Widget A  1  100.00  100.00', line])).toHaveLength(2);
  });
});
