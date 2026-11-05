/**
 * `withoutFootnotes` on every kind of anchor a page can carry: a table row, a column heading, a
 * scorecard row and its PRIOR heading, a KPI tile's trend marker and a disclosure note. Each one
 * that points at a dropped footnote loses the superscript; each one that points at a survivor
 * follows it to its new number.
 */
import { describe, expect, it } from 'vitest';
import { withoutFootnotes } from '@/modules/accounting/services/packs/pages/packFootnoteRenumber';
import type { PackFootnote, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
import { anchorsOf } from './fixtures/packAnchors';

const fn = (number: number): PackFootnote => ({ number, text: `Note ${number}` });
const FOOTNOTES = [fn(1), fn(2), fn(3), fn(4), fn(5)];

const row = (key: string, footnote?: number) => ({
  label: key, key, level: 0 as const, role: 'line' as const, figures: {}, ...(footnote === undefined ? {} : { footnote }),
});
const scoreRow = (metric: string, footnote?: number) => ({
  metric, actual: {}, target: null, prior: null, status: 'met' as const, trend: null, trendSvg: null, bulletSvg: null,
  ...(footnote === undefined ? {} : { footnote }),
});
const tile = (label: string, trendFootnote: number | null) => ({ label, figure: {}, delta: null, deltaAbsence: null, trendFootnote, sparklineSvg: null });

const BLOCKS = [
  { kind: 'table', table: { scale: "R'000", columns: ['actual', 'prior'], rows: [row('a', 1), row('b', 3), row('c', 5), row('d')], columnNotes: [{ column: 'prior', footnote: 4 }, { column: 'actual', footnote: 2 }] } },
  { kind: 'scorecard', groups: [{ letter: 'A', name: 'Growth', rows: [scoreRow('m1', 2), scoreRow('m2', 3), scoreRow('m3')] }], priorFootnote: 5 },
  { kind: 'kpiTiles', tiles: [tile('t1', 1), tile('t2', 4), tile('t3', null)] },
  { kind: 'disclosure', disclosure: { heading: 'D', notes: [{ heading: 'n1', body: 'x', footnote: 3 }, { heading: 'n2', body: 'y', footnote: 5 }, { heading: 'n3', body: 'z' }] } },
] as unknown as PackPageBlock[];

const at = (blocks: PackPageBlock[]) => Object.fromEntries(anchorsOf({ blocks }).map((a) => [a.at, a.n]));

describe('withoutFootnotes', () => {
  const out = withoutFootnotes(BLOCKS, FOOTNOTES, new Set([2, 4]));

  it('numbers the survivors 1..n in list order and keeps their text', () => {
    expect(out.footnotes).toEqual([{ number: 1, text: 'Note 1' }, { number: 2, text: 'Note 3' }, { number: 3, text: 'Note 5' }]);
  });

  it('removes the superscript of a dropped note from a row, a column, a scorecard row, a tile and a disclosure note', () => {
    const anchors = at(out.blocks);
    expect(Object.keys(anchors)).not.toContain('table a row d');
    expect(anchors['table a column prior']).toBeUndefined();
    expect(anchors['table a column actual']).toBeUndefined();
    expect(anchors['scorecard A m1']).toBeUndefined();
    expect(anchors['tile t2']).toBeUndefined();
  });

  it('moves the superscript of a surviving note to its new number', () => {
    expect(at(out.blocks)).toEqual({
      'table a row a': 1, 'table a row b': 2, 'table a row c': 3,
      'scorecard A m2': 2, 'scorecard prior': 3,
      'tile t1': 1,
      'note D / n1': 2, 'note D / n2': 3,
    });
  });

  it('clears the PRIOR heading and a trend marker to null when their note is dropped', () => {
    const gone = withoutFootnotes(BLOCKS, FOOTNOTES, new Set([4, 5])).blocks;
    const sc = gone.find((b) => b.kind === 'scorecard');
    expect(sc?.kind === 'scorecard' && sc.priorFootnote).toBeNull();
    const kt = gone.find((b) => b.kind === 'kpiTiles');
    expect(kt?.kind === 'kpiTiles' && kt.tiles.map((t) => t.trendFootnote)).toEqual([1, null, null]);
  });

  it('removes the superscript of a disclosure note whose footnote is dropped, and only that one', () => {
    // Notes n1 -> 3 and n2 -> 5: dropping 3 takes n1's anchor and n2's follows 5 to its new number.
    const gone = withoutFootnotes(BLOCKS, FOOTNOTES, new Set([3])).blocks;
    const anchors = at(gone);
    expect(anchors['note D / n1']).toBeUndefined();
    expect(anchors['note D / n2']).toBe(4);
  });

  it('removes an anchor whose number is neither dropped nor listed, rather than let it land on another note', () => {
    // Footnote 9 is not on the page. Dropping footnote 2 would renumber 3 to 2, 4 to 3 and 5 to 4: an
    // anchor left at 9 stays dangling, and one at 3 (listed) must follow its note.
    const blocks = [{ kind: 'table', table: { scale: "R'000", columns: ['actual'], rows: [row('a', 9), row('b', 3)] } }] as unknown as PackPageBlock[];
    expect(at(withoutFootnotes(blocks, FOOTNOTES, new Set([2])).blocks)).toEqual({ 'table a row b': 2 });
  });

  it('does not touch its input', () => {
    const before = JSON.stringify(BLOCKS);
    withoutFootnotes(BLOCKS, FOOTNOTES, new Set([1]));
    expect(JSON.stringify(BLOCKS)).toBe(before);
  });
});
