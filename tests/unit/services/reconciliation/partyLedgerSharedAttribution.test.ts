/**
 * The rule that splits a journal several documents carry (see the module header):
 * a leg is counted only when it is provable, otherwise the documents are left out.
 */
import { describe, expect, it } from 'vitest';
import { attributeSharedJournal } from '@/modules/accounting/services/reconciliation/partyLedgerSharedAttribution';

const refs = (...expected: Array<number | null>) => expected.map((e, i) => ({ id: `d${i + 1}`, expected: e }));
const legs = (r: ReturnType<typeof attributeSharedJournal>) => (r.kind === 'attributed' ? Object.fromEntries(r.legs) : null);

describe('attributeSharedJournal', () => {
  it('matches control lines to documents one to one by amount', () => {
    const r = attributeSharedJournal({ headLines: [-200, -300], chainNet: -500, refs: refs(-300, -200), isBatch: false });
    expect(r).toMatchObject({ kind: 'attributed', basis: 'line_match' });
    expect(legs(r)).toEqual({ d1: -300, d2: -200 });
  });

  it('refuses when the lines do not match the documents (an extra line, or a different amount)', () => {
    expect(attributeSharedJournal({ headLines: [-500, -300], chainNet: -800, refs: refs(-500, -200), isBatch: false }).kind).toBe('unattributable');
    expect(attributeSharedJournal({ headLines: [-500], chainNet: -500, refs: refs(-300, -200), isBatch: false }).kind).toBe('unattributable');
  });

  it('accepts one aggregated control line only for a batch, and only when it equals the members summed', () => {
    const batch = attributeSharedJournal({ headLines: [-1000], chainNet: -1000, refs: refs(-600, -400), isBatch: true });
    expect(batch).toMatchObject({ kind: 'attributed', basis: 'batch_total' });
    expect(legs(batch)).toEqual({ d1: -600, d2: -400 });
    // The same shape for non-batch documents is NOT proof of anything.
    expect(attributeSharedJournal({ headLines: [-1000], chainNet: -1000, refs: refs(-600, -400), isBatch: false }).kind).toBe('unattributable');
    // And a batch whose journal disagrees with its members is refused.
    expect(attributeSharedJournal({ headLines: [-900], chainNet: -900, refs: refs(-600, -400), isBatch: true }).kind).toBe('unattributable');
  });

  it('refuses when a sharing document belongs to the other subledger', () => {
    expect(attributeSharedJournal({ headLines: [-300, -200], chainNet: -500, refs: refs(-300, null), isBatch: false }).kind).toBe('unattributable');
  });

  it('scales every leg by what a reversal left of the journal', () => {
    const reversed = attributeSharedJournal({ headLines: [-300, -200], chainNet: 0, refs: refs(-300, -200), isBatch: false });
    expect(legs(reversed)).toEqual({ d1: 0, d2: 0 });
    const half = attributeSharedJournal({ headLines: [-300, -200], chainNet: -250, refs: refs(-300, -200), isBatch: false });
    expect(legs(half)).toEqual({ d1: -150, d2: -100 });
  });

  it('a head with no control line has no leg to divide; a chain that still moves control is unattributable', () => {
    expect(legs(attributeSharedJournal({ headLines: [], chainNet: 0, refs: refs(-300, -200), isBatch: false }))).toEqual({ d1: 0, d2: 0 });
    expect(attributeSharedJournal({ headLines: [], chainNet: -5, refs: refs(-300, -200), isBatch: false }).kind).toBe('unattributable');
  });

  it('equal amounts are interchangeable, so the match is safe', () => {
    const r = attributeSharedJournal({ headLines: [-100, -100], chainNet: -200, refs: refs(-100, -100), isBatch: false });
    expect(legs(r)).toEqual({ d1: -100, d2: -100 });
  });
});
