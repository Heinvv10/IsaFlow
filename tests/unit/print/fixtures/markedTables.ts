/**
 * STATEMENT TABLES WHOSE LABELS ALL CARRY MARKS, OR SOME DO (#1235 round 8, blind M1). With no unmarked row to hold the
 * label column open, round 7 gave it its padding only (39.89px in production against 177.70px unmarked), and the
 * demo's income statement printed at 183mm against 69mm. The demo company's income statement, relabelled after
 * composition and stamped afresh (as the pages API stamps a document): every label in Thai, every label with a
 * VS16 emoji after it, every other label in Thai, and the plain table they are held against.
 */
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import type { PackPage, PackPagesDocument, PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoWithoutBudget } from '../../services/packs/fixtures/widenedFigures';

/** The blind review's Thai account names (revenue, cost of sales, gross profit, operating expenses, ...). */
export const THAI = [
  '\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49', '\u0E15\u0E49\u0E19\u0E17\u0E38\u0E19\u0E02\u0E32\u0E22',
  '\u0E01\u0E33\u0E44\u0E23\u0E02\u0E31\u0E49\u0E19\u0E15\u0E49\u0E19',
  '\u0E04\u0E48\u0E32\u0E43\u0E0A\u0E49\u0E08\u0E48\u0E32\u0E22\u0E43\u0E19\u0E01\u0E32\u0E23\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E07\u0E32\u0E19',
  '\u0E01\u0E33\u0E44\u0E23\u0E08\u0E32\u0E01\u0E01\u0E32\u0E23\u0E14\u0E33\u0E40\u0E19\u0E34\u0E19\u0E07\u0E32\u0E19',
  '\u0E14\u0E2D\u0E01\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E08\u0E48\u0E32\u0E22', '\u0E01\u0E33\u0E44\u0E23\u0E01\u0E48\u0E2D\u0E19\u0E20\u0E32\u0E29\u0E35',
  '\u0E20\u0E32\u0E29\u0E35\u0E40\u0E07\u0E34\u0E19\u0E44\u0E14\u0E49', '\u0E01\u0E33\u0E44\u0E23\u0E2A\u0E38\u0E17\u0E18\u0E34',
];

export type Relabel = (label: string, i: number) => { label: string; footnote?: number };

/** The relabellings held, by name: `plain` is the table the others are held against. */
export const MARKED_TABLES: ReadonlyArray<readonly [string, Relabel]> = [
  ['plain', (label) => ({ label })],
  ['all Thai', (unused, i) => ({ label: THAI[i % THAI.length]! })],
  ['all with a VS16 emoji', (label) => ({ label: `${label} \u2764\uFE0F` })],
  ['every other label Thai', (label, i) => ({ label: i % 2 === 0 ? THAI[i % THAI.length]! : label })],
  ['all Thai, footnoted', (unused, i) => ({ label: THAI[i % THAI.length]!, footnote: 1 + i })],
];

/** The demo's income statement with each row relabelled by `relabel`, stamped. */
export function relabelledStatement(relabel: Relabel): { doc: PackPagesDocument; table: PackTable; index: number } {
  const doc = demoWithoutBudget();
  const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
  const page = doc.pages[index]!;
  const blocks = page.blocks.map((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')
    ? { ...b, table: { ...b.table, rows: b.table.rows.map((r, i) => ({ ...r, ...relabel(r.label, i) })) } } : b));
  const stamped = stampFigureFits({ ...doc, pages: doc.pages.map((p, i) => (i === index ? { ...page, blocks } as PackPage : p)) });
  const table = (stamped.pages[index]!.blocks.find((b) => b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue')) as { table: PackTable }).table;
  return { doc: stamped, table, index };
}
