/**
 * The VAT201 drift check compares like with like (wave 6 EFa round 1): a version that recorded the SARS form is judged
 * field by field against the form built now; an older one by its boxes with key order aside, because jsonb returns an
 * object's keys in its own order (the drawer's false "The SARS form boxes changed" straight after a finalise).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';

const m = vi.hoisted(() => ({ getVat201Report: vi.fn(), getNilRatedSupplies: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: m.getVat201Report }));
vi.mock('@/modules/accounting/services/reports/vat201NilRatedSupplies', () => ({ getNilRatedSupplies: m.getNilRatedSupplies }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { driftOf } from '@/modules/accounting/services/returns/returnDrift';
import { NIL_RATED, VAT_BOXES, VAT_FORM, VAT_TOTALS, VAT_VERSION } from './filingFileSeed';

/** The boxes as jsonb hands them back: keys ordered by length, then bytes. */
const jsonbOrder = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o)
  .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)));
const older: ReturnVersion = { ...VAT_VERSION, figures: { ...VAT_TOTALS, sarsFields: VAT_BOXES.map(jsonbOrder) } };

beforeEach(() => {
  m.getVat201Report.mockResolvedValue({ boxes: VAT_BOXES, totals: VAT_TOTALS });
  m.getNilRatedSupplies.mockResolvedValue(NIL_RATED);
});

describe('VAT201 drift, like for like', () => {
  it('a version with the recorded form: nothing moved, no drift', async () => {
    expect(await driftOf('c1', VAT_VERSION)).toMatchObject({ drifted: false, changed: [], fields: [] });
  });

  it('a version with the recorded form: one field moved (field 2, which the boxes never see) is drift', async () => {
    m.getNilRatedSupplies.mockResolvedValue({ ...NIL_RATED, zeroRated: NIL_RATED.zeroRated + 1 });
    expect(await driftOf('c1', VAT_VERSION)).toMatchObject({ drifted: true, changed: ['sarsFields'] });
  });

  it('an older version (boxes only, keys in jsonb order): nothing moved, no drift; a moved box is drift', async () => {
    expect(JSON.stringify(older.figures.sarsFields)).not.toBe(JSON.stringify(VAT_BOXES)); // the order really differs
    expect(await driftOf('c1', older)).toMatchObject({ drifted: false, changed: [] });
    m.getVat201Report.mockResolvedValue({ boxes: VAT_BOXES.map((b, i) => (i === 0 ? { ...b, base: b.base + 1 } : b)), totals: VAT_TOTALS });
    expect(await driftOf('c1', older)).toMatchObject({ drifted: true, changed: ['sarsFields'] });
  });

  it('the recorded form is the one finalise builds from the same two sources', () => {
    expect((VAT_VERSION.figures.sarsForm as unknown[]).length).toBe(VAT_FORM.length);
  });
});
