/**
 * A FOOTNOTE THE FITTER DROPS TAKES ITS SUPERSCRIPT WITH IT, AND THE SURVIVORS ARE RENUMBERED.
 *
 * `fitPageToBox` takes footnotes to make a page fit. A footnote is only half of an anchor: the
 * table row, column heading, scorecard row, KPI tile or disclosure note that carries its number is
 * the other half, and dropping the text alone left that number printed over nothing. Worse, the
 * trimmer takes ordinary footnotes last-first and PAST the ones that explain a figure, so a
 * required note numbered 5 survived notes 3 and 4 and the omission note then took number 6 -- or,
 * before it counted past the highest survivor, a number a surviving superscript already printed.
 * On page 6 the Gross profit row's "5" then pointed at "Not printed on this page".
 *
 * So a fit that drops footnotes ends here: the anchors of the dropped numbers are removed and the
 * survivors are numbered 1..n in the order the page lists them, with every anchor that pointed at a
 * survivor moved to its new number. Only the page's block list and footnote list are touched; no
 * figure, label or note text changes.
 */
import type { PackFootnote, PackPageBlock, PackTable } from './packPageModel';

/** Where a footnote number goes: its new number, or `null` when its note was dropped. */
type Renumber = (n: number) => number | null;

function renumberTable(table: PackTable, to: Renumber): PackTable {
  const rows = table.rows.map((row) => {
    if (row.footnote === undefined) return row;
    const { footnote, ...rest } = row;
    const next = to(footnote);
    return next === null ? rest : { ...rest, footnote: next };
  });
  const columnNotes = table.columnNotes?.flatMap((c) => {
    const next = to(c.footnote);
    return next === null ? [] : [{ ...c, footnote: next }];
  });
  return { ...table, rows, ...(columnNotes === undefined ? {} : { columnNotes }) };
}

function renumberBlock(block: PackPageBlock, to: Renumber): PackPageBlock {
  switch (block.kind) {
    case 'table':
      return { kind: 'table', table: renumberTable(block.table, to) };
    case 'disclosure':
      return {
        kind: 'disclosure',
        disclosure: {
          ...block.disclosure,
          notes: block.disclosure.notes.map((n) => {
            if (n.footnote === undefined) return n;
            const { footnote, ...rest } = n;
            const next = to(footnote);
            return next === null ? rest : { ...rest, footnote: next };
          }),
        },
      };
    case 'scorecard':
      return {
        ...block,
        groups: block.groups.map((g) => ({
          ...g,
          rows: g.rows.map((r) => {
            if (r.footnote === undefined) return r;
            const { footnote, ...rest } = r;
            const next = to(footnote);
            return next === null ? rest : { ...rest, footnote: next };
          }),
        })),
        ...(block.priorFootnote === null || block.priorFootnote === undefined
          ? {}
          : { priorFootnote: to(block.priorFootnote) }),
      };
    case 'kpiTiles':
      return {
        kind: 'kpiTiles',
        tiles: block.tiles.map((t) => (t.trendFootnote === null ? t : { ...t, trendFootnote: to(t.trendFootnote) })),
      };
    default:
      return block;
  }
}

/**
 * The page's blocks and footnotes once `droppedNumbers` are gone: their anchors removed, the
 * surviving footnotes numbered 1..n in list order, and every anchor moved to its note's new number.
 * An anchor whose number is neither dropped nor listed is left as found.
 */
export function withoutFootnotes(
  blocks: PackPageBlock[],
  footnotes: PackFootnote[],
  droppedNumbers: ReadonlySet<number>,
): { blocks: PackPageBlock[]; footnotes: PackFootnote[] } {
  const kept = footnotes.filter((f) => !droppedNumbers.has(f.number));
  const newNumber = new Map(kept.map((f, i) => [f.number, i + 1]));
  const to: Renumber = (n) => (droppedNumbers.has(n) ? null : newNumber.get(n) ?? n);
  return {
    blocks: blocks.map((b) => renumberBlock(b, to)),
    footnotes: kept.map((f, i) => ({ ...f, number: i + 1 })),
  };
}
