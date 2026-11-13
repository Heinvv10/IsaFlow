/**
 * document_vat_history's pure half (brief step 5a; review round 1): the whole-token pattern, which numbers are
 * searched, the document's direction, and the lines/totals built from journal rows — derivable vs heuristic, the
 * clamp, the cap to the document's own VAT accounts, the late-claim clearing leg. The SQL is proven against a real
 * schema in tests/integration/document-vat-history.int.test.ts and breaker5-mirror.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  documentDirection, isSearchableToken, summariseVatLines, tokenPattern,
} from '@/modules/accounting/services/reports/documentVatHistorySummary';
import type { JournalLineRow } from '@/modules/accounting/services/reports/documentVatHistoryQuery';

/** JS stands in for Postgres ARE here: the pattern uses only syntax both share (lookbehind, alternation). */
const matches = (tokens: string[], text: string) => new RegExp(tokenPattern(tokens), 'i').test(text);
const NO_ROLES = new Set<string>();

let lineSeq = 0;
function row(over: Partial<JournalLineRow>): JournalLineRow {
  const journal = over.journal_entry_id ?? 'je-1';
  return {
    journal_entry_id: journal, root_journal_id: over.root_journal_id ?? journal, created_at: '2026-06-01T10:00:00Z', root_tie: 'posting', via: null, matched_in: null, reverses: null,
    entry_number: 'JE-1', entry_date: '2026-06-01', source: 'auto_supplier_invoice', status: 'posted', stands: true,
    line_id: `l-${++lineSeq}`, gl_account_id: 'cos', account_code: '5010', account_name: 'COS', account_subtype: null,
    vat_type: null, debit: 0, credit: 0, line_description: null, is_vat: false, ...over,
  };
}
const vat = (over: Partial<JournalLineRow>) => row({ gl_account_id: 'vat', account_code: '1140', account_subtype: 'vat_input', vat_type: 'standard', is_vat: true, ...over });
const ap = (over: Partial<JournalLineRow>) => row({ gl_account_id: 'ap', account_code: '2100', account_subtype: 'payable', ...over });

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
    ['SIV3762.', true],
    ['SIV37621 other bill', false],
    ['XSIV3762', false],
    ['ref SIV3762/2', false],
    ['ref SIV3762_2', false],
  ])('SIV3762 in %j → %s', (text, expected) => {
    expect(matches(['SIV3762'], text)).toBe(expected);
  });

  it('a separator followed by a letter or digit continues the token, both directions (breaker REPRO 2)', () => {
    expect(matches(['SIVH-12345'], 'VAT on SIVH-12345-2')).toBe(false);
    expect(matches(['SIVH-12345'], 'VAT on X-SIVH-12345')).toBe(false);
    expect(matches(['SIVH-12345'], 'VAT on 9/SIVH-12345')).toBe(false);
    expect(matches(['SIVH-12345'], 'VAT on SIVH-12345 - returned')).toBe(true);
    expect(matches(['SIVH-12345-2'], 'VAT on SIVH-12345-2')).toBe(true);
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
});

describe('isSearchableToken', () => {
  it.each([['SIV3762', true], ['CN-557', true], ['A1', false], ['ABCD', false], ['12345', true], ['1234', true],
    ['123', false], [`A${'1'.repeat(64)}`, false], [`A${'1'.repeat(63)}`, true]])(
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
  it('a bill, a narration-matched VAT reversal and a credit note: derivable and heuristic apart', () => {
    const rows = [
      ...billJournal(),
      vat({ journal_entry_id: 'je-manual', root_tie: 'narration_match', matched_in: 'narration', credit: 150, entry_number: 'JE-2' }),
      row({ journal_entry_id: 'je-manual', root_tie: 'narration_match', debit: 150 }),
      ap({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', debit: 575 }),
      vat({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', credit: 75 }),
      row({ journal_entry_id: 'je-cn', root_tie: 'credit_note', via: 'CN-1', credit: 500 }),
    ];
    const { lines, totals, matches } = summariseVatLines(rows, 1, NO_ROLES);
    expect(lines.map((l) => [l.tie, l.vat_amount, l.net_base])).toEqual([
      ['posting', 150, 1000], ['narration_match', -150, null], ['credit_note', -75, -500],
    ]);
    expect(matches).toEqual([{ journal_entry_id: 'je-manual', entry_number: 'JE-2', tie: 'narration_match', vat_amount: -150,
      last_created_at: '2026-06-01T10:00:00.000Z' }]);
    expect(totals).toEqual({
      vat_posted: 150, vat_reversed: 225, vat_net_now: -75, vat_derivable_now: 75, vat_heuristic: -150, vat_heuristic_reducing: -150,
      vat_by_tie: { posting: 150, late_claim: 0, reversal: 0, credit_note: -75, reference_match: 0, narration_match: -150 },
      net_base_posted: 1000, net_base_now: 500,
    });
  });

  it('a heuristic match never RAISES vat_net_now (clamp), and counts only on the document\'s own VAT accounts', () => {
    const rows = [
      ...billJournal(),
      vat({ journal_entry_id: 'je-re', root_tie: 'reference_match', debit: 150 }),
      row({ journal_entry_id: 'je-re', root_tie: 'reference_match', credit: 150 }),
      vat({ journal_entry_id: 'je-other', root_tie: 'narration_match', gl_account_id: 'vat-other', credit: 40 }),
    ];
    const { lines, totals } = summariseVatLines(rows, 1, NO_ROLES);
    expect(totals).toMatchObject({ vat_derivable_now: 150, vat_heuristic: 150, vat_heuristic_reducing: 0, vat_net_now: 150 });
    expect(lines.some((l) => l.journal_entry_id === 'je-other')).toBe(false);
  });

  it('each match is judged on its own: an unrelated +150 does not cancel a real -150 (review round 2, R2-1)', () => {
    const rows = [
      ...billJournal(),
      vat({ journal_entry_id: 'je-slip', root_tie: 'narration_match', credit: 150 }),
      vat({ journal_entry_id: 'je-other', root_tie: 'narration_match', debit: 150, created_at: '2026-06-02T09:00:00Z' }),
    ];
    const { totals, matches } = summariseVatLines(rows, 1, NO_ROLES);
    expect(totals).toMatchObject({ vat_heuristic: 0, vat_heuristic_reducing: -150, vat_net_now: 0 });
    expect(matches.map((m) => [m.journal_entry_id, m.vat_amount])).toEqual([['je-slip', -150], ['je-other', 150]]);
  });

  it('a match and its own reversal net to nothing, and the chain\'s latest write is the match\'s last_created_at', () => {
    const rows = [
      ...billJournal(),
      vat({ journal_entry_id: 'je-slip', root_tie: 'narration_match', credit: 150 }),
      vat({ journal_entry_id: 'je-slip-rev', root_journal_id: 'je-slip', root_tie: 'narration_match', debit: 150, created_at: '2026-07-01T08:00:00Z' }),
    ];
    const { totals, matches } = summariseVatLines(rows, 1, NO_ROLES);
    expect(totals).toMatchObject({ vat_heuristic_reducing: 0, vat_net_now: 150 });
    expect(matches).toEqual([expect.objectContaining({ journal_entry_id: 'je-slip', vat_amount: 0, last_created_at: '2026-07-01T08:00:00.000Z' })]);
  });

  it('s16(3): the late-claim clearing leg is VAT, not base; the companion nets on it (architecture A1)', () => {
    const clearing = (over: Partial<JournalLineRow>) => row({ gl_account_id: 'clr', account_subtype: 'vat_input_late_claim', is_vat: true, ...over });
    const rows = [
      row({ journal_entry_id: 'je-bill', debit: 1000 }), clearing({ journal_entry_id: 'je-bill', debit: 150 }),
      ap({ journal_entry_id: 'je-bill', credit: 1150 }),
      vat({ journal_entry_id: 'je-lc', root_tie: 'late_claim', debit: 150 }), clearing({ journal_entry_id: 'je-lc', root_tie: 'late_claim', credit: 150 }),
    ];
    const { totals } = summariseVatLines(rows, 1, NO_ROLES);
    expect(totals).toMatchObject({ vat_posted: 150, vat_derivable_now: 150, net_base_posted: 1000, net_base_now: 1000 });
    expect(totals.vat_by_tie.late_claim).toBe(0);
  });

  it('a journal reached by two ties counts once, under the stronger tie', () => {
    const reversal = [
      vat({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', credit: 150 }),
      row({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', credit: 1000 }),
      ap({ journal_entry_id: 'je-rev', root_tie: 'reversal', reverses: 'je-bill', debit: 1150 }),
    ];
    const asNarration = reversal.map((r) => ({ ...r, root_tie: 'narration_match' as const, reverses: null }));
    const { lines, totals } = summariseVatLines([...billJournal(), ...asNarration, ...reversal], 1, NO_ROLES);
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
    const { lines, totals } = summariseVatLines(rows, -1, NO_ROLES);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ reversed: true, vat_amount: 15, net_base: 100 });
    expect(totals.vat_posted).toBe(15);
  });

  it('a role account (892\'s isBillExpenseLeg) is not base, and two VAT lines leave net_base null', () => {
    const rows = [...billJournal(), vat({ journal_entry_id: 'je-bill', debit: 10, vat_type: 'capital_goods' }),
      row({ journal_entry_id: 'je-bill', gl_account_id: 'role', debit: 5 })];
    const { lines, totals } = summariseVatLines(rows, 1, new Set(['role']));
    expect(lines.map((l) => l.net_base)).toEqual([null, null]);
    expect(totals.net_base_posted).toBe(1000);
    expect(totals.vat_posted).toBe(160);
  });
});
