/**
 * POP bank-line matcher, pure part (popMatchRules.ts): the name test on real ABSA statement wordings, and
 * the rule that only a unique match both ways (one line for the POP, one POP for the line) attaches.
 */
import { describe, expect, it } from 'vitest';
import {
  decideMatches, descriptionNamesBeneficiary, normalizeForMatch, type MatchPair,
} from '@/modules/accounting/services/capture/pop/popMatchRules';

const pair = (popId: string, bankTxId: string, description: string, beneficiary = 'TINTSWALO G MABEHLA'): MatchPair =>
  ({ popId, beneficiary, bankTxId, description });

describe('normalizeForMatch', () => {
  it('upper-cases, folds every run of non-alphanumerics to one space and trims', () => {
    expect(normalizeForMatch('  Imdte Digital Pmt — Absa Bank Tintswalo G Mabehla 161af7fea1 '))
      .toBe('IMDTE DIGITAL PMT ABSA BANK TINTSWALO G MABEHLA 161AF7FEA1');
    expect(normalizeForMatch('IMDTE DIGITAL PMT (     40,00 ) ABSA')).toBe('IMDTE DIGITAL PMT 40 00 ABSA');
    expect(normalizeForMatch(null)).toBe('');
  });
});

describe('descriptionNamesBeneficiary', () => {
  it('finds the beneficiary in each of ABSA\'s statement wordings, whatever the case', () => {
    for (const d of [
      'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA',
      'Imdte Digital Pmt — Absa Bank Tintswalo G Mabehla 161af7fea1',
      'IMDTE DIGITAL PMT (     40,00 ) ABSA BANK TINTSWALO G MABEHLA 161B082ED5',
    ]) expect(descriptionNamesBeneficiary(d, 'Tintswalo G Mabehla')).toBe(true);
  });

  it('matches a beneficiary ABSA truncated mid-word', () => {
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT ABSA BANK AMOEPONG BED AND BREAKFAST', 'Amoepong Bed and Bre')).toBe(true);
  });

  it('refuses a different name, and a name found only inside another word', () => {
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA', 'JANE Q PUBLIC')).toBe(false);
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT ABSA BANK JOANNE SMITH', 'ANNE SMITH')).toBe(false);
  });

  it('never matches a beneficiary of fewer than 3 characters once normalised', () => {
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT ABSA BANK MR X', 'Mr.')).toBe(false);
    expect(descriptionNamesBeneficiary('DIGITAL PAYMENT DT ABSA BANK MRX', 'MRX')).toBe(true);
    expect(descriptionNamesBeneficiary('ANYTHING', ' - ')).toBe(false);
  });
});

describe('decideMatches', () => {
  it('attaches a POP with exactly one named line that no other POP wants', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L1', 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA'),
      pair('p1', 'L2', 'DIGITAL PAYMENT DT ABSA BANK SOMEONE ELSE'), // same amount and day, another name
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'attach', bankTxId: 'L1' });
  });

  it('suggests, and does not attach, when two lines carry the name', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L2', 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA'),
      pair('p1', 'L1', 'IMDTE DIGITAL PMT ABSA BANK TINTSWALO G MABEHLA 161B'),
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1', 'L2'] });
  });

  it('makes both POPs suggestions when two POPs want the same single line', () => {
    const line = 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA';
    const d = decideMatches(['p1', 'p2'], [pair('p1', 'L1', line), pair('p2', 'L1', line)]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
    expect(d.get('p2')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
  });

  it('counts a rival POP outside the batch: its claim on the line still blocks the attach', () => {
    const line = 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA';
    const d = decideMatches(['p1'], [pair('p1', 'L1', line), pair('rival', 'L1', line)]);
    expect(d.get('p1')).toEqual({ outcome: 'ambiguous', candidateBankTxIds: ['L1'] });
    expect(d.has('rival')).toBe(false);
  });

  it('ignores a rival whose name does not match the line', () => {
    const d = decideMatches(['p1'], [
      pair('p1', 'L1', 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA'),
      pair('rival', 'L1', 'DIGITAL PAYMENT DT ABSA BANK TINTSWALO G MABEHLA', 'JANE Q PUBLIC'),
    ]);
    expect(d.get('p1')).toEqual({ outcome: 'attach', bankTxId: 'L1' });
  });

  it('is not_found when no line carries the name, and for a POP with no pairs at all', () => {
    const d = decideMatches(['p1', 'p2'], [pair('p1', 'L1', 'DIGITAL PAYMENT DT ABSA BANK SOMEONE ELSE')]);
    expect(d.get('p1')).toEqual({ outcome: 'not_found' });
    expect(d.get('p2')).toEqual({ outcome: 'not_found' });
  });
});
