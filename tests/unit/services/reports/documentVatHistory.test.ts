/**
 * document_vat_history's pure half (brief step 5a): the whole-token pattern, which numbers are searched,
 * the document's direction, and the lines/totals built from journal rows. The SQL is proven against a
 * real schema in tests/integration/document-vat-history.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  documentDirection, isSearchableToken, summariseVatLines, tokenPattern,
} from '@/modules/accounting/services/reports/documentVatHistory';
import type { JournalLineRow } from '@/modules/accounting/services/reports/documentVatHistoryQuery';

/** JS stands in for Postgres ARE here: the pattern uses only syntax both share (lookbehind, alternation). */
const matches = (tokens: string[], text: string) => new RegExp(tokenPattern(tokens), 'i').test(text);

let lineSeq = 0;
function row(over: Partial<JournalLineRow>): JournalLineRow {
  return {
    journal_entry_id: 'je-1', root_tie: 'posting', via: null, matched_in: null, reverses: null,
    entry_number: 'JE-1', entry_date: '2026-06-01', source: 'auto_supplier_invoice', status: 'posted', stands: true,
    line_id: `l-${++lineSeq}`, gl_account_id: 'acc', account_code: '5010', account_name: 'COS', account_subtype: null,
    vat_type: null, debit: 0, credit: 0, line_description: null, is_vat: false, ...over,
  };
}
const vat = (over: Partial<JournalLineRow>) => row({ account_code: '1140', account_subtype: 'vat_input', vat_type: 'standard', is_vat: true, ...over });
const ap = (over: Partial<JournalLineRow>) => row({ account_code: '2100', account_subtype: 'payable', ...over });

/** A bill journal: DR expense 1000, DR VAT 150, CR AP 1150. */
const billJournal = (id = 'je-bill', tie: JournalLineRow['root_tie'] = 'posting') => [
  row({ journal_entry_id: id, root_tie: tie, debit: 1000 }),
  vat({ journal_entry_id: id, root_tie: tie, debit: 150 }),
  ap({ journal_entry_id: id, root_tie: tie, credit: 1150 }),
];

describe('tokenPattern — a document number as a whole token', () => {
  it.each([
    ['Slip review: reverse input VAT on SIV3762', true],
    ['siv3762 vat', true],
    ['(SIV3762)', true],
    ['SIV37621 other bill', false],
    ['XSIV3762', false],
    ['ref SIV3762/2', true],
  ])('SIV3762 in %j → %s', (text, expected) => {
    expect(matches(['SIV3762'], text)).toBe(expected);
  });

  it('is not fooled by a number inside a decimal amount', () => {
    expect(matches(['123456'], 'paid 123456.50')).toBe(false);
    expect(matches(['123456'], 'paid 9.123456')).toBe(false);
    expect(matches(['123456'], 'inv 123456.')).toBe(true);
  });

  it('escapes regex metacharacters in a number', () => {
    expect(matches(['INV.2026+1'], 'see INV.2026+1 here')).toBe(true);
    expect(matches(['INV.2026+1'], 'see INVX2026+1 here')).toBe(false);
  });

  it('matches any of several tokens', () => {
    expect(matches(['SIV3762', 'EXT-998877'], 'EXT-998877 reversal')).toBe(true);
  });
});

describe('isSearchableToken — numbers too weak to search narration for are skipped', () => {
  it.each([['SIV3762', true], ['CN-557', true], ['A1', false], ['ABCD', false], ['12345', false], ['123456', true]])(
    '%s → %s', (t, expected) => expect(isSearchableToken(t)).toBe(expected),
  );
});

describe('documentDirection', () => {
  it('bill and customer note debit VAT; invoice and supplier note credit it', () => {
    expect(documentDirection('supplier_invoice', null)).toBe(1);
    expect(documentDirection('customer_invoice', null)).toBe(-1);
    expect(documentDirection('credit_note', 'supplier')).toBe(-1);
    expect(documentDirection('credit_note', 'customer')).toBe(1);
  });
});

describe('summariseVatLines', () => {
  it('a bill, a narration-matched VAT reversal and a credit note: totals in the bill\'s direction', () => {
    const rows = [
      ...billJournal(),
      vat({ journal_entry_id: 'je-manual', root_tie: 'narration_match', matched_in: 'narration', credit: 150, entry_number: 'JE-2' }),
      row({ journal_entry_id: 'je-manual', root_tie: 'narration_match', debit: 150 }),
      ap({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', debit: 575 }),
      vat({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', credit: 75 }),
      row({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', credit: 500 }),
    ];
    const { lines, totals } = summariseVatLines(rows, 1);
    expect(lines.map((l) => [l.tie, l.vat_amount, l.net_base])).toEqual([
      ['posting', 150, 1000], ['narration_match', -150, null], ['credit_note', -75, -500],
    ]);
    expect(lines[2]!.tied_via).toBe('CN-1');
    expect(totals).toEqual({
      vat_posted: 150, vat_reversed: 225, vat_net_now: -75,
      vat_by_tie: { posting: 150, reversal: 0, credit_note: -75, reference_match: 0, narration_match: -150 },
      net_base_posted: 1000, net_base_now: 500,
    });
  });

  it('a journal reached by two ties counts once, under the stronger tie', () => {
    const reversal = [
      vat({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', credit: 150 }),
      row({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', credit: 1000 }),
      ap({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', debit: 1150 }),
    ];
    const asNarration = reversal.map((r) => ({ ...r, root_tie: 'narration_match' as const, reverses: null }));
    const { lines, totals } = summariseVatLines([...billJournal(), ...asNarration, ...reversal], 1);
    expect(lines.filter((l) => l.journal_entry_id === 'je-rev').map((l) => l.tie)).toEqual(['reversal']);
    expect(totals.vat_net_now).toBe(0);
    expect(totals.net_base_now).toBe(0);
  });

  it('flags a journal that no longer stands as reversed, and signs a customer invoice\'s output VAT positive', () => {
    const rows = [
      row({ journal_entry_id: 'je-inv', account_subtype: 'receivable', debit: 115, stands: false }),
      row({ journal_entry_id: 'je-inv', account_subtype: 'revenue', credit: 100, stands: false }),
      vat({ journal_entry_id: 'je-inv', account_subtype: 'vat_output', credit: 15, stands: false }),
    ];
    const { lines, totals } = summariseVatLines(rows, -1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ reversed: true, vat_amount: 15, net_base: 100 });
    expect(totals.vat_posted).toBe(15);
  });

  it('leaves net_base null on a line of a journal with two VAT lines', () => {
    const rows = [...billJournal(), vat({ journal_entry_id: 'je-bill', debit: 10, vat_type: 'capital_goods' })];
    const { lines, totals } = summariseVatLines(rows, 1);
    expect(lines.map((l) => l.net_base)).toEqual([null, null]);
    expect(totals.net_base_posted).toBe(1000);
    expect(totals.vat_posted).toBe(160);
  });
});
