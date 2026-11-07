/**
 * The composed demo pack with the figures of one block widened AFTER composition (the composer's gates do not
 * run on it; the figure fits are stamped afresh, as the pages API stamps a document), for the tests that take the width of a figure row to its thresholds without needing a revenue
 * beyond JavaScript's safe integers.
 */
import { log } from '@/lib/logger';
import { vi } from 'vitest';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage, PackPagesDocument, PackTable, PackTableColumnKey } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './boardPackInputs';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';

type KpiTiles = Array<(PackPage['blocks'][number] & { kind: 'kpiTiles' })['tiles'][number]>;

export const SCALE = "R'000" as const;
export const money = (digits: number): number => Number(`9${'0'.repeat(digits - 1)}`) * 1000;
const widen = (figure: PackFigure, digits: number): PackFigure => (figure.format === 'money' && figure.value !== null ? { ...figure, value: money(digits) } : figure);

export interface TableMarks {
  /** Row 0 carries a footnote marker after its label. */
  labelMarker?: boolean;
  /** Row 0's actual is not meaningful (a reason, so an `n/m` cell with its note mark). */
  notMeaningful?: boolean;
}

export function withWidenedTable(doc: PackPagesDocument, digits: number, longLabel?: string, marks: TableMarks = {}): { doc: PackPagesDocument; table: PackTable; index: number } {
  const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
  const page = doc.pages[index]!;
  const blocks = page.blocks.map((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')
    ? { ...b, table: { ...b.table, rows: b.table.rows.map((r, i) => ({ ...r, ...(longLabel !== undefined && i === 0 ? { label: longLabel, level: 2 as const } : {}), ...(marks.labelMarker === true && i === 0 ? { footnote: 1 } : {}), figures: Object.fromEntries(Object.entries(r.figures).map(([c, f]) => [c, marks.notMeaningful === true && i === 0 && c === 'actual' ? { ...f, value: null, unavailable: 'no base period' } : widen(f, digits)])) })) } }
    : b));
  const stamped = stampFigureFits({ ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p)) });
  const table = (stamped.pages[index]!.blocks.find((b) => b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')) as { table: PackTable }).table;
  return { doc: stamped, table, index };
}

/** Words set in the second KPI tile in place of its own: a label, a not-meaningful reason (the figure goes), a delta basis. */
export interface KpiWords { label?: string; reason?: string; basis?: string }

function widenTile(tile: KpiTiles[number], w: KpiWords, digits: number): KpiTiles[number] {
  const figure = w.reason === undefined
    ? { ...tile.figure, format: 'money' as const, value: money(digits) }
    : { ...tile.figure, format: 'money' as const, value: null, unavailable: w.reason };
  const delta = w.basis === undefined ? tile.delta : { ...(tile.delta ?? { value: 0.12, unit: 'percent' as const, favourable: true }), basis: w.basis };
  return { ...tile, ...(w.label === undefined ? {} : { label: w.label }), figure, delta };
}

export function withWidenedKpi(doc: PackPagesDocument, digits: number, words: string | KpiWords = {}): { doc: PackPagesDocument; tiles: KpiTiles; index: number } {
  const w: KpiWords = typeof words === 'string' ? { label: words } : words;
  const index = doc.pages.findIndex((p) => p.navLabel === 'Highlights');
  const page = doc.pages[index]!;
  const blocks = page.blocks.map((b) => (b.kind === 'kpiTiles'
    ? { ...b, tiles: b.tiles.map((t, i) => (i < 4 ? widenTile(t, i === 1 ? w : {}, digits) : t)) }
    : b));
  const stamped = stampFigureFits({ ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p)) });
  const tiles = (stamped.pages[index]!.blocks.find((b) => b.kind === 'kpiTiles') as { tiles: KpiTiles }).tiles;
  return { doc: stamped, tiles, index };
}

export function demoWithoutBudget(): PackPagesDocument {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try { return buildBoardPackPages({ ...demoInput, set: { ...demoInput.set, budget: null } }); } finally { warn.mockRestore(); }
}


/**
 * The income statement's table rebuilt with exactly these columns, every cell a tiny figure, so that the HEADINGS
 * (and, with `marked`, their footnote markers) are what sets the columns' widths.
 */
export function withHeadingColumns(doc: PackPagesDocument, columns: readonly PackTableColumnKey[], marked: boolean): { doc: PackPagesDocument; table: PackTable; index: number } {
  const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
  const page = doc.pages[index]!;
  const source = page.blocks.find((b) => b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')) as { table: PackTable };
  const table: PackTable = {
    ...source.table,
    columns,
    columnNotes: marked ? columns.map((column, i) => ({ column, footnote: i + 1 })) : [],
    rows: source.table.rows.map((r) => ({
      ...r,
      figures: Object.fromEntries(columns.map((c) => [c, { ...(r.figures.actual ?? Object.values(r.figures)[0]!), value: 100, format: 'money' as const }])),
    })),
  };
  const blocks = page.blocks.map((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue') ? { ...b, table } : b));
  const stamped = stampFigureFits({ ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p)) });
  return { doc: stamped, table: (stamped.pages[index]!.blocks.find((b) => b.kind === 'table') as { table: PackTable }).table, index };
}
