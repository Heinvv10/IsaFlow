/**
 * keepStoredDimensions: what a draft line keeps of its CC1 / CC2 / BU when the
 * draft's lines are replaced wholesale (customer invoice PUT, update_supplier_invoice).
 *
 * A key sent wins (a value sets it, null clears it). A key left out keeps the
 * value every stored line shares, and is refused when the stored lines differ
 * on it. A CC2 sent (or cleared) leaves the CC1 to derivation.
 */
import { describe, expect, it } from 'vitest';
import { keepStoredDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionKeepStored';

const row = (cc1: string | null, cc2: string | null, bu: string | null) => ({ cc1_id: cc1, cc2_id: cc2, bu_id: bu });
const line = (dims: Record<string, string | null> = {}) => ({ description: 'x', ...dims });

describe('keepStoredDimensions', () => {
  it('keeps every dimension the stored lines share when the lines leave all three out', () => {
    const out = keepStoredDimensions([line(), line()], [row('F1', 'P1', 'B1'), row('f1', 'p1', 'b1')]);
    expect(out).toEqual([
      { description: 'x', cc1Id: 'f1', cc2Id: 'p1', buId: 'b1' },
      { description: 'x', cc1Id: 'f1', cc2Id: 'p1', buId: 'b1' },
    ]);
  });

  it('keeps nothing when no stored line carries a dimension, or there are no stored lines', () => {
    expect(keepStoredDimensions([line()], [row(null, null, null)])).toEqual([{ description: 'x' }]);
    expect(keepStoredDimensions([line()], [])).toEqual([{ description: 'x' }]);
  });

  it('a value sent wins; null clears it', () => {
    const out = keepStoredDimensions([line({ buId: 'B2', cc2Id: null })], [row('F1', 'P1', 'B1')]);
    // cc2 cleared, so the CC1 the old project gave is left to derivation (customer FNO or none); bu replaced.
    expect(out).toEqual([{ description: 'x', buId: 'B2' }]);
    // No stored line had a project: the stored CC1 was typed, not derived, and is kept.
    expect(keepStoredDimensions([line({ cc2Id: null })], [row('F1', null, null)])).toEqual([{ description: 'x', cc1Id: 'f1' }]);
    expect(keepStoredDimensions([line({ cc1Id: null, cc2Id: null, buId: null })], [row('F1', 'P1', 'B1')]))
      .toEqual([{ description: 'x' }]);
  });

  it('a CC2 sent leaves CC1 to derivation instead of keeping the stored FNO', () => {
    expect(keepStoredDimensions([line({ cc2Id: 'P2' })], [row('F1', 'P1', 'B1')]))
      .toEqual([{ description: 'x', cc2Id: 'P2', buId: 'b1' }]);
  });

  it('refuses a key left out when the stored lines differ on it, naming the line and the key', () => {
    const stored = [row('F1', 'P1', 'B1'), row('F1', 'P1', 'B2')];
    expect(() => keepStoredDimensions([line({ buId: 'B1' }), line()], stored, (i) => `items[${i}]`))
      .toThrow(/items\[1\].*different BU.*buId/);
    // A line that sends the key it would otherwise have to guess is fine.
    expect(keepStoredDimensions([line({ buId: 'B1' }), line({ buId: null })], stored))
      .toEqual([{ description: 'x', cc1Id: 'f1', cc2Id: 'p1', buId: 'B1' }, { description: 'x', cc1Id: 'f1', cc2Id: 'p1' }]);
  });

  it('a stored line with no value and one with a value differ too', () => {
    expect(() => keepStoredDimensions([line()], [row(null, 'P1', null), row(null, null, null)])).toThrow(/CC2/);
  });

  it('refuses CC1 by the same rule when no CC2 is sent, and raises a DimensionRefusal', () => {
    let caught: unknown;
    try {
      keepStoredDimensions([line({ cc2Id: null })], [row('F1', null, null), row('F2', null, null)]);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('DIMENSION_REFUSED');
    expect(String(caught)).toMatch(/Line 1.*CC1/);
  });
});
