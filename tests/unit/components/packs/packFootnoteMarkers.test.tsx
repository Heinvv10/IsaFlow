/**
 * The renderer half of "every footnote points at something".
 *
 * The model can anchor a footnote all it likes; until the component draws the
 * superscript, the page still prints a numbered note pointing at nothing. Two
 * markers were missing entirely — `ComparativeTable` drew none at all, so the
 * whole numbered series on pages 5 to 8 was unanchored — and `MattersTable`
 * never collected the lettered reason its QUANTUM column's `n/m` has always
 * carried.
 *
 * See `tests/unit/services/packs/packFootnotesAreAnchored.test.ts` for the
 * model half.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComparativeTable } from '@/components/accounting/packs/primitives/ComparativeTable';
import { MattersTable } from '@/components/accounting/packs/primitives/MattersTable';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoShortPanelsInput } from '../../services/packs/fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

function page(navLabel: string): PackPage {
  const found = buildBoardPackPages(liveDemoShortPanelsInput).pages
    .find((p) => p.navLabel === navLabel);
  if (found === undefined) throw new Error(`no ${navLabel} page`);
  return found;
}

describe('ComparativeTable draws the numbered footnote markers', () => {
  it('marks the row a footnote is about', () => {
    const cash = page('Cash');
    const block = cash.blocks.find((b) => b.kind === 'table')!;
    const table = block.kind === 'table' ? block.table : null;
    const row = table!.rows.find((r) => r.label === 'Opening cash')!;
    expect(row.footnote, 'the model stopped anchoring it').toBeDefined();

    render(<ComparativeTable table={table!} scale={PACK_SCALE} />);
    const cell = screen.getByText('Opening cash').closest('td')!;
    expect(within(cell).getByText(String(row.footnote))).toBeTruthy();
  });

  it('marks the PRIOR column heading', () => {
    const income = page('Income statement');
    const block = income.blocks.find((b) => b.kind === 'table')!;
    const table = block.kind === 'table' ? block.table : null;
    const note = table!.columnNotes?.find((c) => c.column === 'prior');
    expect(note, 'the model stopped anchoring the comparative period').toBeDefined();

    render(<ComparativeTable table={table!} scale={PACK_SCALE} />);
    const heading = screen.getByText('Prior').closest('th')!;
    expect(within(heading).getByText(String(note!.footnote))).toBeTruthy();
  });
});

describe('MattersTable carries the lettered reason its n/m has always had', () => {
  it('marks the unquantified quantum and prints the reason once beneath', () => {
    const matters = page('Matters for the board');
    const block = matters.blocks.find((b) => b.kind === 'matters')!;
    if (block.kind !== 'matters') throw new Error('no matters block');
    const unquantified = block.matters.filter((m) => m.quantum.value === null);
    expect(unquantified.length, 'no unquantified matter on this pack').toBeGreaterThan(0);

    render(<MattersTable matters={block.matters} omitted={block.omitted} scale={PACK_SCALE} />);
    // The mark: an `n/m` with a superscript beside it, not a bare `n/m`.
    const marks = screen.getAllByText('n/m');
    expect(marks.length).toBeGreaterThan(0);
    const marked = marks.some((m) => (m.closest('td')?.querySelector('sup')) !== null
      || m.parentElement?.querySelector('sup') !== null);
    expect(marked, 'the QUANTUM n/m prints with no lettered mark').toBe(true);
    // And the reason itself, once, under the table. Matched on the container's
    // text because `NotMeaningfulNotes` renders it as "n/m — <reason>", so the
    // reason is not a text node of its own.
    const reason = unquantified[0]!.quantum.unavailable!;
    const notes = document.querySelectorAll('dl.pack-table-notes');
    const printed = Array.from(notes).map((n) => n.textContent ?? '').join(' ');
    expect(printed, 'the reason prints nowhere under the table').toContain(reason);
  });
});
