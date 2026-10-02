/**
 * SIX LINES OF THE SAME WIDTH, DRAWN OVER DIFFERENT WINDOWS.
 *
 * Page 3's tiles carry a sparkline each, all the same size, side by side —
 * and two of them cover a third of the window the others cover. Gross margin
 * and debtor days have no meaningful figure in a month with no revenue, so
 * those months are dropped rather than plotted as a false zero; on the live
 * demo company that is nine of twelve, three points against twelve, with
 * nothing on the sheet saying the windows differ. Comparing the shapes is
 * the only thing a strip of sparklines is for.
 *
 * The pack states this everywhere else it happens — page 4's
 * `PANEL_OMITTED_RULE`, page 10's "over N periods" titles — and page 3's
 * version is its own sparkline footnote, which was already anchored on every
 * tile that carries a line.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackKpiTile, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

function highlights(doc: PackPagesDocument): { tiles: PackKpiTile[]; footnote: string } {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'kpiTiles') continue;
      const anchored = block.tiles.find((t) => t.trendFootnote !== null);
      const footnote = page.footnotes.find((f) => f.number === anchored?.trendFootnote);
      expect(footnote, 'the tiles anchor a footnote the page does not carry').toBeDefined();
      return { tiles: block.tiles, footnote: footnote!.text };
    }
  }
  throw new Error('no KPI tile strip in this pack');
}

describe("page 3 says which months each tile's line covers", () => {
  it('names the short lines, their window and why, on the demo company', () => {
    const { tiles, footnote } = highlights(buildBoardPackPages(liveDemoShortPanelsInput));
    const short = tiles.filter((t) => t.sparklineWindow !== null && t.sparklineWindow.plotted < t.sparklineWindow.of);
    // NOT VACUOUS: this fixture is here because its ratio series are short.
    expect(short.map((t) => t.label), 'no tile draws a short line, so the note is untested').not.toEqual([]);
    for (const tile of short) {
      expect(footnote, `${tile.label} draws a short line the sheet does not mention`).toContain(tile.label);
      expect(footnote).toContain(`${tile.sparklineWindow!.plotted} of the window's ${tile.sparklineWindow!.of} months`);
    }
    expect(footnote).toContain('dropped rather than drawn as zero');
  });

  it('says nothing about short windows where every line covers the whole one', () => {
    const { tiles, footnote } = highlights(buildBoardPackPages(brightsphereLiveInput));
    const short = tiles.filter((t) => t.sparklineWindow !== null && t.sparklineWindow.plotted < t.sparklineWindow.of);
    if (short.length > 0) {
      for (const tile of short) expect(footnote).toContain(tile.label);
      return;
    }
    expect(footnote, 'a sheet whose lines all cover the window still explains a short one')
      .not.toContain('of the window');
  });

  it('counts the months it plots, not the months it was handed', () => {
    // The window is the CLAIM the footnote is built from, so it has to be the
    // drawing's own count rather than the series length.
    const { tiles } = highlights(buildBoardPackPages(liveDemoShortPanelsInput));
    for (const tile of tiles) {
      if (tile.sparklineSvg === null) {
        expect(tile.sparklineWindow, `${tile.label} states a window with no line`).toBeNull();
        continue;
      }
      expect(tile.sparklineWindow, `${tile.label} draws a line and states no window`).not.toBeNull();
      const points = (tile.sparklineSvg as unknown as string).match(/L[-\d.]+ [-\d.]+/g)?.length ?? 0;
      expect(tile.sparklineWindow!.plotted, `${tile.label} plots a different number of points than it states`)
        .toBe(points + 1);
    }
  });
});
