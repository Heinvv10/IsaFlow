/**
 * The wording of a dropped cost-centre pick (lib/costCentrePickWording): the
 * sentence the server returns and the reader the screens use on it are one
 * module, and every reason round-trips — so the notice's title can always say
 * which centre and why.
 */
import { describe, it, expect } from 'vitest';
import { parsePickDropSentence, pickDropFact, pickDropSentence, type PickDrop } from '@/lib/costCentrePickWording';

const DROPS: PickDrop[] = [
  { line: 1, reason: 'inactive', code: 'OLD' },
  { line: 12, reason: 'occupied', code: 'FT' },
  { line: 3, reason: 'conflict', code: 'PH' },
  { line: 2, reason: 'inactive', code: 'A code — with: punctuation. was not applied' },
];

describe('cost-centre pick wording', () => {
  it('the sentences the postings return', () => {
    expect(DROPS.slice(0, 3).map(pickDropSentence)).toEqual([
      'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.',
      'Line 12: cost centre FT was not applied — the line already carries its own CC1 or project.',
      'Line 3: project PH was not applied — it belongs to another FNO than the line\'s CC1.',
    ]);
  });

  it('every sentence reads back to the line, the reason and the code it was built from', () => {
    for (const drop of DROPS) expect(parsePickDropSentence(pickDropSentence(drop)), drop.code).toEqual(drop);
  });

  it('a sentence that is not one of these reads back as null', () => {
    for (const s of ['', 'Input VAT on entertainment is denied.', 'Line 1: something else happened.',
      'cost centre OLD is inactive and was not applied — the line posts without it.',
      'Line 1: cost centre is inactive and was not applied — the line posts without it.']) { // no code at all
      expect(parsePickDropSentence(s), s).toBeNull();
    }
  });

  it('the fact for a title: which centre, and why, in a few words', () => {
    expect(DROPS.slice(0, 3).map(pickDropFact)).toEqual([
      'cost centre OLD not applied (inactive)',
      'cost centre FT not applied (the line has its own)',
      'project PH not applied (another FNO)',
    ]);
  });
});
