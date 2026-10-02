/**
 * The renderer half of "the five scorecard blocks share one grid".
 *
 * The model can state widths all it likes; until the table draws a
 * `<colgroup>` and the CSS says `table-layout: fixed`, the browser sizes each
 * of the five tables from its own content — which is what moved TARGET 10mm
 * and PRIOR 14mm between blocks on the rendered page.
 *
 * See `tests/unit/services/packs/packScorecardColumns.test.ts` for the widths
 * themselves and the clipping guard.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ScorecardTable } from '@/components/accounting/packs/primitives/ScorecardTable';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoShortPanelsInput } from '../../services/packs/fixtures/liveDemoBoardPack';
import type { PackScorecardGroup } from '@/modules/accounting/services/packs/pages/packPageModel';

function groups(): PackScorecardGroup[] {
  for (const page of buildBoardPackPages(liveDemoShortPanelsInput).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'scorecard') return block.groups;
    }
  }
  throw new Error('no scorecard in this pack');
}

describe('ScorecardTable states one grid for every group', () => {
  it('gives every group table the same column widths', () => {
    const all = groups();
    expect(all.length, 'the scorecard stopped printing several groups').toBeGreaterThan(1);

    const { container } = render(<ScorecardTable groups={all} scale={PACK_SCALE} />);
    const tables = [...container.querySelectorAll('table.pack-scorecard-group')];
    expect(tables).toHaveLength(all.length);

    const widthsOf = (table: Element): string[] =>
      [...table.querySelectorAll('colgroup col')].map((c) => (c as HTMLElement).style.width);

    const first = widthsOf(tables[0]!);
    expect(first.length, 'no colgroup — the browser sizes each table from its own content')
      .toBeGreaterThan(0);
    for (const table of tables.slice(1)) {
      expect(widthsOf(table), 'two groups state different column widths').toEqual(first);
    }
  });

  it('states a width for every column it draws', () => {
    const all = groups();
    const { container } = render(<ScorecardTable groups={all} scale={PACK_SCALE} />);
    const table = container.querySelector('table.pack-scorecard-group')!;
    const cols = table.querySelectorAll('colgroup col').length;
    const headers = table.querySelectorAll('thead th').length;
    // A colgroup shorter than the header row leaves the tail columns to the
    // browser, which is the defect wearing a colgroup.
    expect(cols).toBe(headers);
  });
});
