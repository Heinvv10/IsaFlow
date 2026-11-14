/**
 * POP bank-line matcher, pure part (popMatchRules.ts): the name test on real ABSA statement wordings and on the
 * names that must NOT match (a prefix of a longer word, a word of the ABSA wording itself, a folded accent), and
 * the rule that only a unique match both ways, on an account imported past the window, attaches.
 */
import { describe, expect, it } from 'vitest';
import {
  decideMatches, descriptionNamesBeneficiary, normalizeForMatch, type MatchPair,
} from '@/modules/accounting/services/capture/pop/popMatchRules';

const named = (name: string) => `DIGITAL PAYMENT DT ABSA BANK ${name}`;
const pair = (popId: string, bankTxId: string, description: string | null, beneficiary = 'TINTSWALO G MABEHLA',
  windowImported = true): MatchPair => ({ popId, beneficiary, bankTxId, description, windowImported });

describe('normalizeForMatch', () => {
  it('folds accents, upper-cases, folds every run of other characters to one space and trims', () => {
    expect(normalizeForMatch('  Imdte Digital Pmt — Absa Bank Tintswalo G Mabehla 161af7fea1 '))
      .toBe('IMDTE DIGITAL PMT ABSA BANK TINTSWALO G MABEHLA 161AF7FEA1');
    expect(normalizeForMatch('IMDTE DIGITAL PMT (     40,00 ) ABSA')).toBe('IMDTE DIGITAL PMT 40 00 ABSA');
    expect(normalizeForMatch('José Ñandú')).toBe('JOSE NANDU');
    expect(normalizeForMatch(null)).toBe('');
  });
});

describe('descriptionNamesBeneficiary', () => {
  it('finds the beneficiary after "ABSA BANK" in each of ABSA\'s statement wordings, whatever the case', () => {
    for (const d of [
      'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA',
      'Imdte Digital Pmt — Absa Bank Tintswalo G Mabehla 161af7fea1',
      'IMDTE DIGITAL PMT (     40,00 ) ABSA BANK TINTSWALO G MABEHLA 161B082ED5',
    ]) expect(descriptionNamesBeneficiary(d, 'Tintswalo G Mabehla')).toBe(true);
  });

  it('leaves the end open only for a beneficiary of exactly ABSA\'s 20 characters', () => {
    expect('Amoepong Bed and Bre').toHaveLength(20);
    expect(descriptionNamesBeneficiary(named('AMOEPONG BED AND BREAKFAST'), 'Amoepong Bed and Bre')).toBe(true);
    expect('Amoepong Bed and Br').toHaveLength(19);
    expect(descriptionNamesBeneficiary(named('AMOEPONG BED AND BREAKFAST'), 'Amoepong Bed and Br')).toBe(false);
  });

  it('refuses a name that is only the start of a longer word', () => {
    expect(descriptionNamesBeneficiary(named('JOHNSON PLUMBING'), 'John')).toBe(false);
    expect(descriptionNamesBeneficiary(named('ANNE SMITHSON'), 'ANNE SMITH')).toBe(false);
    expect(descriptionNamesBeneficiary(named('JOSHUA K'), 'José')).toBe(false);
    expect(descriptionNamesBeneficiary(named('JOSE K'), 'José')).toBe(true);
    expect(descriptionNamesBeneficiary(named('JOHN K'), 'John')).toBe(true);
  });

  it('refuses a name found inside another word, or only in ABSA\'s own wording before "ABSA BANK"', () => {
    expect(descriptionNamesBeneficiary(named('JOANNE SMITH'), 'ANNE SMITH')).toBe(false);
    for (const word of ['ABSA', 'DIGITAL', 'IMDTE', 'ABSA BANK', 'PAYMENT DT']) {
      for (const d of [
        'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA',
        'IMDTE DIGITAL PMT (     40,00 ) ABSA BANK TINTSWALO G MABEHLA 161B082ED5',
      ]) expect([word, d, descriptionNamesBeneficiary(d, word)]).toEqual([word, d, false]);
    }
  });

  it('never matches a description without "ABSA BANK", or none at all', () => {
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT TINTSWALO G MABEHLA', 'Tintswalo G Mabehla')).toBe(false);
    expect(descriptionNamesBeneficiary('ABSABANK TINTSWALO G MABEHLA', 'Tintswalo G Mabehla')).toBe(false);
    expect(descriptionNamesBeneficiary(null, 'Tintswalo G Mabehla')).toBe(false);
    expect(descriptionNamesBeneficiary('', 'Tintswalo G Mabehla')).toBe(false);
  });

  it('never matches a beneficiary of fewer than 3 characters once normalised', () => {
    expect(descriptionNamesBeneficiary(named('MR X'), 'Mr.')).toBe(false);
    expect(descriptionNamesBeneficiary(named('MRX'), 'MRX')).toBe(true);
    expect(descriptionNamesBeneficiary(named('ANYTHING'), ' - ')).toBe(false);
  });
});

describe('decideMatches', () => {
  it('attaches a POP with exactly one named line that no other POP wants, on an account imported past the window', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L1', named('TINTSWALO G MABEHLA')),
      pair('p1', 'L2', named('SOMEONE ELSE')), // same amount and day, another name
      pair('p1', 'L3', null),
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'attach', bankTxId: 'L1' });
  });

  it('waits (not_found) while the line\'s account is not imported past the window', () => {
    const d = decideMatches(['p1'], [pair('p1', 'L1', named('TINTSWALO G MABEHLA'), undefined, false)]);
    expect(d.get('p1')).toEqual({ outcome: 'not_found' });
  });

  it('suggests, and does not attach, when two lines carry the name, imported or not', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L2', named('TINTSWALO G MABEHLA'), undefined, false),
      pair('p1', 'L1', 'IMDTE DIGITAL PMT ABSA BANK TINTSWALO G MABEHLA 161B'),
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1', 'L2'] });
  });

  it('makes both POPs suggestions when two POPs want the same single line', () => {
    const line = named('TINTSWALO G MABEHLA');
    const d = decideMatches(['p1', 'p2'], [pair('p1', 'L1', line), pair('p2', 'L1', line)]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
    expect(d.get('p2')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
  });

  it('counts a rival POP outside the batch: its claim on the line still blocks the attach', () => {
    const line = named('TINTSWALO G MABEHLA');
    const d = decideMatches(['p1'], [pair('p1', 'L1', line), pair('rival', 'L1', line)]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
    expect(d.has('rival')).toBe(false);
  });

  it('ignores a rival whose name does not match the line', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L1', named('TINTSWALO G MABEHLA')),
      pair('rival', 'L1', named('TINTSWALO G MABEHLA'), 'JANE Q PUBLIC'),
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'attach', bankTxId: 'L1' });
  });

  it('is not_found when no line carries the name, and for a POP with no pairs at all', () => {
    const d = decideMatches(['p1', 'p2'], [pair('p1', 'L1', named('SOMEONE ELSE'))]);
    expect(d.get('p1')).toEqual({ outcome: 'not_found' });
    expect(d.get('p2')).toEqual({ outcome: 'not_found' });
  });
});
