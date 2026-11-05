/**
 * The composed demo pack with the figures of one block widened AFTER composition (the composer's gates do not
 * run on it), for the tests that take the width of a figure row to its thresholds without needing a revenue
 * beyond JavaScript's safe integers.
 */
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { log } from '@/lib/logger';
import { vi } from 'vitest';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage, PackPagesDocument, PackTable, PackTableColumnKey } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './boardPackInputs';

export const SCALE = "R'000" as const;
export const money = (digits: number): number => Number(`9${'0'.repeat(digits - 1)}`) * 1000;
const widen = (figure: PackFigure, digits: number): PackFigure => (figure.format === 'money' && figure.value !== null ? { ...figure, value: money(digits) } : figure);

export function withWidenedTable(doc: PackPagesDocument, digits: number, longLabel?: string): { doc: PackPagesDocument; table: PackTable; index: number } {
  const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
  const page = doc.pages[index]!;
  const blocks = page.blocks.map((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')
    ? { ...b, table: { ...b.table, rows: b.table.rows.map((r, i) => ({ ...r, ...(longLabel !== undefined && i === 0 ? { label: longLabel, level: 2 as const } : {}), figures: Object.fromEntries(Object.entries(r.figures).map(([c, f]) => [c, widen(f, digits)])) })) } }
    : b));
  const table = (blocks.find((b) => b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')) as { table: PackTable }).table;
  const pages = doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p));
  return { doc: { ...doc, pages }, table, index };
}

export function withWidenedKpi(doc: PackPagesDocument, digits: number): { doc: PackPagesDocument; texts: Array<string | null>; index: number } {
  const index = doc.pages.findIndex((p) => p.navLabel === 'Highlights');
  const page = doc.pages[index]!;
  const blocks = page.blocks.map((b) => (b.kind === 'kpiTiles'
    ? { ...b, tiles: b.tiles.map((t, i) => (i < 4 ? { ...t, figure: { ...t.figure, format: 'money' as const, value: money(digits) } } : t)) }
    : b));
  const kpi = blocks.find((b) => b.kind === 'kpiTiles') as { tiles: Array<{ figure: PackFigure }> };
  const texts = kpi.tiles.map((t) => (t.figure.value === null ? null : formatFigureText(t.figure, SCALE)));
  const pages = doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p));
  return { doc: { ...doc, pages }, texts, index };
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
  return { doc: { ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p)) }, table, index };
}
