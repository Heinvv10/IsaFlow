/**
 * TWO FOOTNOTE SYSTEMS, AND ONLY THE LETTERED ONE WORKED.
 *
 * Every `n/m` in the pack carries a lettered mark to its reason. The NUMBERED
 * footnotes at the feet of pages 5 to 9 carried nothing at all: twelve of
 * them on the live demo pack, every one printed under a sheet with no
 * superscript anywhere on it. "Opening cash in the table above is the balance
 * at the START of the reporting period" sat under a table whose Opening cash
 * row had no marker; "The prior column is the period 26 April 2025 to 31
 * December 2025" sat under a column heading that said only "Prior".
 *
 * Page 3's has always been anchored, through `PackKpiTile.trendFootnote`,
 * which is what made the rest look deliberate rather than forgotten.
 *
 * This holds the whole series on both companies, off the composed document,
 * so a footnote added without an anchor cannot reach a board.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereReceivablesGapInput, demoInput, denseInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const PACKS: Array<[string, BoardPackInput]> = [
  ['the live demo company', liveDemoShortPanelsInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere', brightsphereReceivablesGapInput],
  ['the demo company', demoInput],
  ['a dense pack', denseInput],
];

/** Every numbered footnote this page anchors, from every block that can. */
function anchored(page: PackPage): Set<number> {
  const out = new Set<number>();
  for (const block of page.blocks) {
    if (block.kind === 'disclosure') {
      for (const n of block.disclosure.notes) if (n.footnote !== undefined) out.add(n.footnote);
    }
    if (block.kind === 'table') {
      for (const r of block.table.rows) if (r.footnote !== undefined) out.add(r.footnote);
      for (const c of block.table.columnNotes ?? []) out.add(c.footnote);
    }
    if (block.kind === 'scorecard') {
      for (const g of block.groups) for (const r of g.rows) if (r.footnote !== undefined) out.add(r.footnote);
      // The PRIOR heading is an anchor too — five of them, one per lettered
      // group, on the sheet that prints the column five times.
      if (block.priorFootnote !== null && block.priorFootnote !== undefined) out.add(block.priorFootnote);
    }
    if (block.kind === 'kpiTiles') {
      for (const t of block.tiles) if (t.trendFootnote !== null) out.add(t.trendFootnote);
    }
  }
  return out;
}

describe('every numbered footnote points at something on its own sheet', () => {
  it.each(PACKS)('%s', (unusedName, input) => {
    const orphans: string[] = [];
    for (const page of buildBoardPackPages(input).pages) {
      const marks = anchored(page);
      for (const f of page.footnotes) {
        if (!marks.has(f.number)) orphans.push(`p${page.number} ${page.navLabel} fn${f.number}`);
      }
    }
    expect(orphans, `unanchored footnotes: ${orphans.join(', ')}`).toEqual([]);
  });

  it('and the series is not empty, so the assertion above can fail', () => {
    // An anti-vacuity guard: a pack that stopped printing numbered footnotes
    // would satisfy the test above without satisfying anything else.
    const pages = buildBoardPackPages(liveDemoShortPanelsInput).pages;
    expect(pages.reduce((n, p) => n + p.footnotes.length, 0)).toBeGreaterThanOrEqual(12);
  });
});

describe('the anchors are on the thing each footnote is about', () => {
  const pageNamed = (input: BoardPackInput, navLabel: string): PackPage =>
    buildBoardPackPages(input).pages.find((p) => p.navLabel === navLabel)!;

  it('the opening-cash window note marks the Opening cash row', () => {
    const page = pageNamed(liveDemoShortPanelsInput, 'Cash');
    const table = page.blocks.find((b) => b.kind === 'table')!;
    const row = table.kind === 'table'
      ? table.table.rows.find((r) => r.label === 'Opening cash') : undefined;
    const note = page.footnotes.find((f) => f.text.startsWith('Opening cash in the table above'))!;
    expect(note).toBeDefined();
    expect(row?.footnote).toBe(note.number);
  });

  it('the comparative-period note marks the PRIOR column heading', () => {
    const page = pageNamed(liveDemoShortPanelsInput, 'Income statement');
    const table = page.blocks.find((b) => b.kind === 'table')!;
    const note = page.footnotes.find((f) => f.text.startsWith('The prior column is the period'))!;
    expect(note).toBeDefined();
    expect(table.kind === 'table' ? table.table.columnNotes : undefined)
      .toContainEqual({ column: 'prior', footnote: note.number });
  });

  it('the debtor-days note marks the Debtor days scorecard row', () => {
    const page = pageNamed(liveDemoShortPanelsInput, 'Scorecard');
    const note = page.footnotes[0];
    if (note === undefined) return;
    const block = page.blocks.find((b) => b.kind === 'scorecard')!;
    const row = block.kind === 'scorecard'
      ? block.groups.flatMap((g) => g.rows).find((r) => r.metric === 'Debtor days') : undefined;
    expect(row?.footnote).toBe(note.number);
  });

  it('the rounding note marks the row a reader\'s addition lands on', () => {
    // Page 5's "so each row adds across" is FALSE on four of the twelve rows
    // — Nov 2025 reads 2 − 119 − 17 against a printed (133) — and three of
    // its column totals are one out. The page has always printed the
    // rounding note; nothing pointed at it, so an absolute claim stood
    // unqualified on the table that disproves it.
    const page = pageNamed(liveDemoShortPanelsInput, 'Monthly results');
    const table = page.blocks.find((b) => b.kind === 'table')!;
    const total = table.kind === 'table'
      ? table.table.rows.filter((r) => r.role === 'total').at(-1) : undefined;
    expect(total?.footnote).toBe(1);
    const claim = page.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
      .find((n) => n.body.includes('each row adds across'));
    expect(claim, 'page 5 stopped claiming its rows add across').toBeDefined();
    expect(claim?.footnote, 'the claim stands unqualified on the table that disproves it').toBe(1);
  });
});
