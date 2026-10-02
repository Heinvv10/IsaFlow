/**
 * The renderer half of "a declared comparative column with no figure is not a
 * nil" — see `tests/unit/services/packs/packAbsentPriorCell.test.ts` for the
 * model half and for what page 8 printed before it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComparativeTable } from '@/components/accounting/packs/primitives/ComparativeTable';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { liveDemoInput } from '../../services/packs/fixtures/liveDemoBoardPack';

function cashTable(): PackTable {
  for (const page of buildBoardPackPages(liveDemoInput).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'table' && block.table.rows.some((r) => r.label === 'Opening cash')) {
        return block.table;
      }
    }
  }
  throw new Error('no cash table in this pack');
}

describe('ComparativeTable', () => {
  it('prints n/m, not the nil glyph, in opening cash\'s comparative cells', () => {
    render(<ComparativeTable table={cashTable()} scale="R'000" />);
    const cells = screen.getByText('Opening cash').closest('tr')!.querySelectorAll('td');
    // Column 0 is the label and column 1 the actual; the three comparative
    // cells follow it.
    const printed = Array.from(cells).slice(2, 5).map((cell) => cell.textContent ?? '');
    expect(printed).toHaveLength(3);
    for (const text of printed) {
      expect(text).toContain('n/m');
      expect(text).not.toContain('–');
    }
  });
});
