/**
 * Migration 890 — a supplier's default CC1 / CC2 / BU on its bill lines.
 *
 * Precedence (brief §5.5, as for card defaults): the line's own dimensions win;
 * the default CC2/CC1 only fill a line that names neither; the BU defaults on
 * its own; a line or bill on the legacy cost-centre pick takes no CC default.
 * The bill screen's pre-fill re-stamps only lines still on the old default.
 */
import { describe, expect, it } from 'vitest';
import {
  applySupplierDefaultDimensions, supplierDefaultRefsFromBody,
} from '@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults';
import { restampLines } from '@/components/accounting/suppliers/useSupplierDimensionDefaults';

const DEF = { cc1Id: 'fno-def', cc2Id: 'proj-def', buId: 'bu-def' };

describe('applySupplierDefaultDimensions', () => {
  it('fills a line that names nothing with all three defaults', () => {
    expect(applySupplierDefaultDimensions([{ description: 'x' }], DEF))
      .toEqual([{ description: 'x', cc1Id: 'fno-def', cc2Id: 'proj-def', buId: 'bu-def' }]);
  });

  it("keeps the line's own CC2 and BU, and never pairs that CC2 with the default FNO", () => {
    expect(applySupplierDefaultDimensions([{ cc2Id: 'proj-line', buId: 'bu-line' }], DEF))
      .toEqual([{ cc2Id: 'proj-line', buId: 'bu-line' }]);
  });

  it('gives a line that names only an FNO no default project, but still the default BU', () => {
    expect(applySupplierDefaultDimensions([{ cc1Id: 'fno-line' }], DEF))
      .toEqual([{ cc1Id: 'fno-line', buId: 'bu-def' }]);
  });

  it('gives a line (or a bill) on the legacy cost-centre pick no CC default', () => {
    expect(applySupplierDefaultDimensions([{ costCenterId: 'legacy' }], DEF))
      .toEqual([{ costCenterId: 'legacy', buId: 'bu-def' }]);
    expect(applySupplierDefaultDimensions([{}], DEF, 'legacy-bill')).toEqual([{ buId: 'bu-def' }]);
  });

  it('applies a CC1-only default (overhead supplier) to an open line', () => {
    expect(applySupplierDefaultDimensions([{}], { cc1Id: 'ovh' })).toEqual([{ cc1Id: 'ovh' }]);
  });

  it('changes nothing when the supplier has no defaults', () => {
    const lines = [{ cc2Id: '' }, {}];
    expect(applySupplierDefaultDimensions(lines, {})).toEqual(lines);
  });
});

describe('supplierDefaultRefsFromBody', () => {
  it('returns null when the body names none of the three', () => {
    expect(supplierDefaultRefsFromBody({})).toBeNull();
  });

  it('maps set values and turns null or empty into a clear', () => {
    expect(supplierDefaultRefsFromBody({ defaultCc2Id: 'p', defaultBuId: null, defaultCc1Id: '' }))
      .toEqual({ cc2: 'p', bu: null, cc1: null });
  });
});

describe('restampLines (bill screen pre-fill)', () => {
  const PREV = { cc2Id: 'proj-a', buId: 'bu-a' };
  const NEXT = { cc2Id: 'proj-b', buId: 'bu-b' };

  it('moves blank lines and lines still on the previous default to the new default', () => {
    expect(restampLines([{ cc2Id: '', buId: '' }, { cc2Id: 'proj-a', buId: 'bu-a' }], PREV, NEXT))
      .toEqual([{ cc2Id: 'proj-b', buId: 'bu-b' }, { cc2Id: 'proj-b', buId: 'bu-b' }]);
  });

  it('keeps a value the user picked', () => {
    expect(restampLines([{ cc2Id: 'proj-user', buId: 'bu-a' }], PREV, NEXT))
      .toEqual([{ cc2Id: 'proj-user', buId: 'bu-b' }]);
  });

  it('clears the old default when the new supplier has none', () => {
    expect(restampLines([{ cc2Id: 'proj-a', buId: 'bu-a' }], PREV, { cc2Id: '', buId: '' }))
      .toEqual([{ cc2Id: '', buId: '' }]);
  });
});
