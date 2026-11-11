/**
 * A TITLE IS MEASURED AS IT PRINTS: WITH ITS COMPOUNDS KEPT WHOLE (#1263 round 2). The page and chart titles print
 * through `keepCompounds`, which sets the hyphen inside a compound as U+2011 so Chromium does not break there; the
 * model breaks after a plain hyphen (`packLineBreaks.pieces`), so measured as written a title with a compound near a
 * line end read a line short. The title is found, not written down: the first length at which breaking after its
 * hyphens would save a line, so the case keeps discriminating if the faces or the sizes move.
 */
import { describe, expect, it } from 'vitest';
import { keepCompounds } from '@/components/accounting/packs/primitives/keepCompounds';
import { chartTitleMm } from '@/modules/accounting/services/packs/pages/packChartBox';
import { blockMm, pageHeaderMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE, type ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { GUTTER_MM, PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';

/** The first title of a lead word and n compounds whose compounds, kept whole, cost a line. */
function discriminating(style: ProseStyle, mm: number): string {
  // A lead word of each length shifts where the compounds meet the line's end.
  for (let lead = 1; lead < 24; lead += 1) {
    for (let n = 1; n < 40; n += 1) {
      const title = `${'R'.repeat(lead)} ${Array.from({ length: n }, (unused, i) => (i % 2 === 0 ? 'year-on-year' : 'non-positive')).join(' ')}`;
      if (proseLines(keepCompounds(title), style, mm) > proseLines(title, style, mm)) return title;
    }
  }
  throw new Error('no title discriminates');
}

describe('a title with hyphenated compounds', () => {
  it('a page title costs what it prints, compounds whole', () => {
    const title = discriminating(PROSE.title, PAGE_WIDTH_MM.portrait);
    const page = (t: string) => ({ title: t, navLabel: 'Highlights', section: 'Overview' as const, orientation: 'portrait' as const, density: 'high' as const, blocks: [], footnotes: [] });
    expect(pageHeaderMm(page(title), 'portrait')).toBe(pageHeaderMm(page(keepCompounds(title)), 'portrait'));
  });

  it('a small-multiples panel title too', () => {
    const measure = (PAGE_WIDTH_MM.portrait - GUTTER_MM) / 2;
    const title = discriminating(PROSE.panelTitle, measure);
    const block = (t: string) => ({ kind: 'smallMultiples', panels: [{ title: t, heightMm: 40 }, { title: 'Revenue', heightMm: 40 }] }) as unknown as PackPageBlock;
    expect(blockMm(block(title), 'portrait')).toBe(blockMm(block(keepCompounds(title)), 'portrait'));
  });

  it('a chart title too', () => {
    const title = discriminating(PROSE.chartTitle, 80);
    expect(chartTitleMm(title, 80)).toBe(chartTitleMm(keepCompounds(title), 80));
  });
});
