/**
 * A row label printed to break anywhere (`packAnywhereLabel.ts`) is priced per code point, and holds its column open by
 * its floor, in the model, in the fit gate and in the print (#1235 round 8, adversarial H1: one grapheme held seven
 * emoji, a conjunct chain or a run of marks drawn with an advance, read a line short and ran up to 193px over the
 * figures). The proof that the floor is the print's and that no label runs past its cell is production's image
 * (`printParity/packAnywhereLabelImage.test.ts`, `printParity/packBreakPairsImage.test.ts`); this holds the logic.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComparativeTable } from '@/components/accounting/packs/primitives/ComparativeTable';
import { anywhereFloorPx, markedClusterPx } from '@/modules/accounting/services/packs/pages/packAnywhereLabel';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { CELL_SIDE_PX, INDENT_PX_PER_LEVEL, labelMarkExactPx, tableFit } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { anywhereFloor, isFigureFit, unstampedBlock, type StampedPackTable } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import { assertFiguresReadable, unreadableBlock } from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { labelLineCount, tableLayout } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { FAMILIES, ROUND_EIGHT_FITTING, ROUND_EIGHT_LABELS, ROUND_NINE_LABELS } from '../../print/fixtures/anywhereFamilies';
import { printsAnywhere } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { demoWithoutBudget, SCALE, withWidenedTable } from './fixtures/widenedFigures';

const WIDEST = FALLBACK.label400.widest;
const codePoints = (t: string): number => [...t].length;

describe('a grapheme that carries a mark is priced per code point', () => {
  it('each of the seven families is one grapheme, priced at the widest fallback glyph for every code point in it', () => {
    for (const family of FAMILIES) {
      for (const n of [1, 6, 12]) {
        const cluster = family(n);
        expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(cluster)].length, JSON.stringify(cluster)).toBe(1);
        expect(markedClusterPx(cluster, 400)).toBe(WIDEST * codePoints(cluster));
      }
    }
    // Stacked spacing marks: one each.
    expect(markedClusterPx('\u0915\u093E\u093E\u093E', 600)).toBe(FALLBACK.label600.widest * 4);
  });

  it('the floor is the widest grapheme of the marked labels at that price, in whole pixels; none without a mark', () => {
    expect(anywhereFloorPx([{ label: 'Revenue', weight: 400 }])).toBeNull();
    expect(anywhereFloorPx([{ label: 'Telecomq\u0301munications', weight: 400 }])).toBe(2 * WIDEST);
    // A grapheme without a mark in a marked label counts too: seven emoji joined by ZWJ.
    const chain = `${'\u{1F600}\u200D'.repeat(6)}\u{1F600}`;
    expect(anywhereFloorPx([{ label: `q\u0301 ${chain}`, weight: 400 }, { label: 'Revenue', weight: 600 }])).toBe(13 * WIDEST);
    expect(anywhereFloorPx([{ label: `Rent ${FAMILIES[0]!(14)}`, weight: 500 }])).toBe(43 * FALLBACK.label500.widest);
  });
});

describe('a letter that joins, which the faces lack, is printed to break anywhere and priced at the bound (round 9)', () => {
  const sadhe = (n: number): string => '\u0728'.repeat(n);
  it('prints anywhere: Arabic, Syriac, Mongolian, N\'Ko, Adlam; not Latin, CJK, an emoji ZWJ sequence or ZWNJ alone', () => {
    for (const t of [sadhe(17), 'Rent \u0628\u064A\u0646', '\u182E\u1823\u1829', '\u07DE\u07CA', '\u{1E900}\u{1E923}', '\u0640']) expect(printsAnywhere(t), t).toBe(true);
    for (const t of ['Revenue', '\u4E2D\u6587', '\u{1F600}\u200D\u{1F600}', 'a\u200Cb', '\u0660\u0661']) expect(printsAnywhere(t), t).toBe(false);
  });

  it('each joining letter at the widest fallback glyph, in a line and in the floor: a SADHE run of 40 at 200px is 20 lines', () => {
    expect(anywhereFloorPx([{ label: sadhe(17), weight: 400 }])).toBe(WIDEST);
    expect(labelLineCount(sadhe(40), null, 400, 200, WRAP_GUARD_PX)).toBe(20);
    // After a marked word too (H1): "q\u0301 " then the run, two letters a line.
    expect(labelLineCount(`q\u0301 ${sadhe(40)}`, null, 400, 200, WRAP_GUARD_PX)).toBe(21);
    // A run the faces set is priced as the ruler sets it.
    expect(labelLineCount('q\u0301 Revenue', null, 400, 400, WRAP_GUARD_PX)).toBe(1);
  });

  it('the review\'s round-9 tables carry a floor, and a SADHE label\'s column holds it', () => {
    for (const [label, labelMarker] of ROUND_NINE_LABELS) {
      const { table } = withWidenedTable(demoWithoutBudget(), 12, label, { labelMarker });
      expect(table.figureFit!.labelFloorPx, JSON.stringify(label)).toBe(anywhereFloorPx([{ label, weight: 400 }]));
      if (table.figureFit!.fits) expect(tableLayout(table, SCALE, 'portrait').columnsPx[0]!).toBeGreaterThanOrEqual(table.figureFit!.labelFloorPx! + 2 * INDENT_PX_PER_LEVEL + CELL_SIDE_PX - 1e-6);
    }
  });
});

describe('a footnote mark after a label printed to break anywhere', () => {
  // The print may break before the mark (`pack-label-anywhere` breaks anywhere), so where the last line leaves less
  // room than the mark it takes a line of its own. No label in production's image needs it: a marked grapheme is
  // priced so far over what it prints (two glyphs at the least) that every last line the print fills the model has
  // already broken. It is held here (blind round 8, L2, mutation B).
  it('takes a line of its own where the last line leaves less room than it, and none where it fits', () => {
    const avail = 2 * WIDEST + WRAP_GUARD_PX + 1;
    expect(labelLineCount('q\u0301', null, 400, avail, WRAP_GUARD_PX)).toBe(1);
    expect(labelMarkExactPx(1, 400)).toBeGreaterThan(1);
    expect(labelLineCount('q\u0301', 1, 400, avail, WRAP_GUARD_PX)).toBe(2);
    expect(labelLineCount('q\u0301', 1, 400, avail + labelMarkExactPx(1, 400), WRAP_GUARD_PX)).toBe(1);
  });
});

describe('the floor in the fit gate, the layout and the print', () => {
  it('a marked label\'s floor is stamped on the fit, held by the label column in the layout, and set as the label\'s min-width', () => {
    for (const digits of [9, 12]) {
      const { table } = withWidenedTable(demoWithoutBudget(), digits, 'Telecomq\u0301munications');
      expect(table.figureFit).toMatchObject({ fits: true, labelFloorPx: 2 * WIDEST });
      const layout = tableLayout(table, SCALE, 'portrait');
      // Row 0 is at level 2, with its padding on the right.
      expect(layout.columnsPx[0]!).toBeGreaterThanOrEqual(2 * WIDEST + 2 * INDENT_PX_PER_LEVEL + CELL_SIDE_PX - 1e-6);
      const html = renderToStaticMarkup(createElement(ComparativeTable, { table: table as StampedPackTable, scale: SCALE }));
      expect(html).toContain(`<span class="pack-label-anywhere" style="min-width:${2 * WIDEST}px">`);
    }
    const plain = withWidenedTable(demoWithoutBudget(), 9).table;
    expect(plain.figureFit).toEqual({ px: null, fits: true });
  });

  it('a grapheme wider than the room the figures leave is never printed over them: the table does not fit and the pack is refused', () => {
    // The review's three overrun labels (the last ran 193.4px over the figures at 12 digits) and its seven short ones.
    for (const [label, labelMarker] of ROUND_EIGHT_LABELS) {
      for (const digits of [9, 12]) {
        const { doc, table, index } = withWidenedTable(demoWithoutBudget(), digits, label, { labelMarker });
        expect(table.figureFit!.fits, `${JSON.stringify(label)}, ${digits} digits`).toBe(false);
        expect(table.figureFit!.labelFloorPx).toBe(anywhereFloorPx([{ label, weight: 400 }]));
        // The label is named where the table fits with it at its own widest piece and the floor alone breaks it. Three
        // are too wide even so (fifteen emoji in one grapheme, a 41-letter conjunct chain): those stand as the figures'.
        const own = [`Rent ${FAMILIES[0]!(14)}|12`, `Telecommunications ${FAMILIES[4]!(40)}|9`, `Telecommunications ${FAMILIES[4]!(40)}|12`].includes(`${label}|${digits}`);
        expect(unreadableBlock(doc.pages[index]!, SCALE)).toEqual(own ? { kind: 'table' } : { kind: 'table', label });
        if (!own) expect(() => assertFiguresReadable(doc.pages, SCALE)).toThrow(`row label "${label}" holds a character the print cannot break`);
      }
    }
  });

  it('the families at lengths the figures leave room for print at 9 digits, at their floor', () => {
    for (const [label, labelMarker] of ROUND_EIGHT_FITTING) {
      for (const digits of [9]) {
        const { table } = withWidenedTable(demoWithoutBudget(), digits, label, { labelMarker });
        expect(table.figureFit, `${JSON.stringify(label)}, ${digits} digits`).toMatchObject({ fits: true, labelFloorPx: anywhereFloorPx([{ label, weight: 400 }]) });
      }
    }
  });

  it('a fit with a floor is printable only on a table, as a whole positive pixel; a marked label without one is refused', () => {
    expect(isFigureFit({ px: null, fits: true, labelFloorPx: 174 }, 'table')).toBe(true);
    for (const bad of [0, -1, 174.5, '174', null]) expect(isFigureFit({ px: null, fits: true, labelFloorPx: bad }, 'table'), String(bad)).toBe(false);
    expect(isFigureFit({ px: null, fits: true, labelFloorPx: 174 }, 'kpi')).toBe(false);
    const { table } = withWidenedTable(demoWithoutBudget(), 9, 'Telecomq\u0301munications');
    const bare = { ...table, figureFit: { px: table.figureFit!.px, fits: true } };
    expect(unstampedBlock({ kind: 'table', table: bare })).toMatch(/no floor/);
    expect(unstampedBlock({ kind: 'table', table })).toBeNull();
    expect(() => anywhereFloor(bare.figureFit)).toThrow(/anywhereFloor/);
    expect(() => renderToStaticMarkup(createElement(ComparativeTable, { table: bare as StampedPackTable, scale: SCALE }))).toThrow(/anywhereFloor/);
    expect(tableFit(bare, SCALE).labelFloorPx).toBe(2 * WIDEST);
  });
});
