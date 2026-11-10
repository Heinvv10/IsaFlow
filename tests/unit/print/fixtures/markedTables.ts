/**
 * STATEMENT TABLES WHOSE LABELS ALL CARRY MARKS, OR SOME DO (#1235 round 8, blind M1). With no unmarked row to hold the
 * label column open, round 7 gave it its padding only (39.89px in production against 177.70px unmarked), and the
 * demo's income statement printed at 183mm against 69mm. The demo company's income statement, relabelled after
 * composition and stamped afresh (as the pages API stamps a document): every label in Thai, every label with a
 * VS16 emoji after it, every other label in Thai; in Arabic, Syriac and Mongolian (round 9: letters that join, printed
 * to break anywhere too); and the plain table they are held against.
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

/** Persian, Urdu and Arabic account names (the round-9 adversarial review's): letters that join. */
export const ARABIC = [
  '\u0628\u06CC\u0645\u0647 \u0648 \u0645\u0627\u0644\u06CC\u0627\u062A',
  '\u0647\u0632\u06CC\u0646\u0647\u200C\u0647\u0627\u06CC \u0639\u0645\u0648\u0645\u06CC',
  '\u0627\u062C\u0627\u0631\u0647 \u0628\u0647\u0627',
  '\u062A\u0646\u062E\u0648\u0627\u0647 \u06AF\u0631\u062F\u0627\u0646',
  '\u0645\u0635\u0627\u0631\u0641 \u0639\u0645\u0648\u0645\u06CC',
  '\u06C1\u0632\u06CC\u0646\u06C1',
  '\u06A9\u0631\u0627\u06CC\u06C1 \u0627\u0648\u0631 \u0628\u062C\u0644\u06CC',
  '\u0628\u06CC\u0646\u06A9 \u0686\u0627\u0631\u062C\u0632',
  '\u067E\u06CC\u0634\u06AF\u06CC \u0627\u062F\u0627\u0626\u06CC\u06AF\u06CC',
  '\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u062F\u0627\u0626\u0646\u064A\u0646',
  '\u0645\u0635\u0631\u0648\u0641\u0627\u062A \u0625\u062F\u0627\u0631\u064A\u0629',
];

/** Syriac words (the same review's), and its SADHE run. */
export const SYRIAC = [
  '\u0721\u072B\u071D\u071A\u0710',
  '\u0710\u0720\u0717\u0710',
  '\u071F\u072C\u0712\u0710 \u0715\u071A\u0718\u072B\u0712\u0722\u0710',
  '\u0728\u0720\u0718\u072C\u0710',
  '\u0728\u071D\u0715\u0710',
  '\u0710\u071D\u071F\u0722\u0710',
  '\u071A\u0718\u072B\u0712\u0722\u0710 \u0715\u0721\u0726\u0729\u072C\u0710',
  '\u0722\u071D\u0722\u0718\u0710',
  '\u0723\u0718\u072A\u071D\u071D\u0710',
  '\u0710\u072A\u0721\u071D\u071D\u0710',
  '\u0728\u0728\u0728',
];

/** Mongolian words (the same review's). */
export const MONGOLIAN = [
  '\u182E\u1823\u1829\u182D\u1823\u182F \u1824\u182F\u1824\u1830',
  '\u182C\u1825\u1837\u1825\u1829\u182D\u1821',
  '\u1835\u1820\u1837\u1824\u1834\u1820\u182D\u1824\u182F',
  '\u1823\u1837\u1823\u182F\u182D\u180E\u1820',
  '\u1832\u1825\u182F\u1826\u182A\u1826\u1837\u1822',
  '\u1830\u1820\u1829\u182C\u1826\u1826',
  '\u182D\u1821\u1837 \u182A\u1826\u182F\u1822',
  '\u182A\u1820\u1836\u1822\u182D\u1824\u182F\u1824\u182F\u182D\u180E\u1820',
];

/** Japanese account names (the round-10 adversarial review's, and the pack's own in Japanese). */
export const JAPANESE_NAMES = [
  '\u58F2\u4E0A\u9AD8', '\u58F2\u4E0A\u539F\u4FA1', '\u58F2\u4E0A\u7DCF\u5229\u76CA', '\u55B6\u696D\u8CBB\u7528',
  '\u30D0\u30F3\u30AF\u624B\u6570\u6599', '\u55B6\u696D\u5229\u76CA', '\u30D1\u30F3\u30D5\u30EC\u30C3\u30C8\u5370\u5237\u8CBB', '\u5F53\u671F\u7D14\u5229\u76CA',
];

export type Relabel = (label: string, i: number) => { label: string; footnote?: number };

/** The relabellings held, by name: `plain` is the table the others are held against. */
export const MARKED_TABLES: ReadonlyArray<readonly [string, Relabel]> = [
  ['plain', (label) => ({ label })],
  ['all Thai', (unused, i) => ({ label: THAI[i % THAI.length]! })],
  ['all with a VS16 emoji', (label) => ({ label: `${label} \u2764\uFE0F` })],
  ['every other label Thai', (label, i) => ({ label: i % 2 === 0 ? THAI[i % THAI.length]! : label })],
  ['all Thai, footnoted', (unused, i) => ({ label: THAI[i % THAI.length]!, footnote: 1 + i })],
  ['all Arabic', (unused, i) => ({ label: ARABIC[i % ARABIC.length]! })],
  ['all Syriac', (unused, i) => ({ label: SYRIAC[i % SYRIAC.length]! })],
  ['all Mongolian', (unused, i) => ({ label: MONGOLIAN[i % MONGOLIAN.length]! })],
  ['every other label Arabic', (label, i) => ({ label: i % 2 === 0 ? ARABIC[i % ARABIC.length]! : label })],
  ['all with a combining accent', (label) => ({ label: `${label} q\u0301` })],
  ['every other label with a combining accent, footnoted', (label, i) => ({ label: i % 2 === 0 ? `Telecomq\u0301munications ${label}` : label, footnote: 1 + i })],
  ['all Japanese', (unused, i) => ({ label: JAPANESE_NAMES[i % JAPANESE_NAMES.length]! })],
  ['all with an emoji', (label) => ({ label: `${label} \u{1F4B0}` })],
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
