/**
 * The integrity checks that walk a page's BLOCKS rather than its figures —
 * spec §7.2 checks 4 (each bridge foots) and 6 (a column headed `prior` is
 * filled from prior-period readings).
 *
 * A sibling of `packFigureIntegrity.ts`, which is at the repo's 300-line
 * ceiling and owns the figure-level checks. The split is along the grain of
 * the two jobs: one resolves a printed FIGURE against the provenance map,
 * this one reads what a page SAYS. Nothing changed in the move except
 * `checkPlugDisclosure` gaining the document's scale, without which the
 * sentence it re-derives could never match the one the page printed.
 */
import { checkWaterfall, disproportionatePlugSentence } from './packWaterfallIntegrity';
import { checkColumns } from './packStatementIntegrity';
import type { MoneyScale } from '@/lib/format/money';
import type { PackChartSpec, PackPagesDocument } from '../pages/packPageModel';

/**
 * Every sentence a page puts in front of a reader — disclosure notes and
 * rendered narrative. A mandatory disclosure is satisfied by the page SAYING
 * it, wherever it is carried, not by a particular block kind holding it.
 */
function pageProse(page: PackPagesDocument['pages'][number]): string[] {
  return page.blocks.flatMap((block) => {
    if (block.kind === 'disclosure') return block.disclosure.notes.map((n) => n.body);
    if (block.kind === 'narrative') return [block.narrative.body ?? ''];
    return [];
  });
}

/**
 * A bridge may lean on its plug, but the page may not stay quiet about it.
 *
 * The plug itself is accepted — see `disproportionatePlugSentence` for why a
 * disclosure and not a refusal. What is refused is drawing a plug that
 * outweighs what it is plugging and leaving the reader to notice: the bridge
 * foots, so nothing else in this gate would ever fire on it.
 */
function checkPlugDisclosure(
  page: PackPagesDocument['pages'][number],
  chart: PackChartSpec,
  scale: MoneyScale,
): string[] {
  const sentence = disproportionatePlugSentence(chart, scale);
  if (sentence === null) return [];
  if (pageProse(page).some((text) => text.includes(sentence))) return [];
  return [
    `Page ${page.number}'s bridge '${chart.id}' leans on an unmeasured step ` +
      `and the page does not say so. It must carry: ${sentence}`,
  ];
}

/**
 * Checks 4 and 6, both of which walk the page blocks rather than figures.
 *
 * `scale` is the document's own, narrowed by the caller: the plug disclosure
 * it re-derives prints a rand amount, and a sentence built at a different
 * scale from the one the page printed would never match the page's text —
 * the gate would refuse a pack that says exactly what it must.
 */
export function checkBlocks(doc: PackPagesDocument, scale: MoneyScale): string[] {
  const failures: string[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'table') {
        failures.push(...checkColumns(block.table, `Page ${page.number} table`));
      } else if (block.kind === 'chart') {
        if (block.chart.kind === 'waterfall') {
          failures.push(...checkWaterfall(block.chart));
          failures.push(...checkPlugDisclosure(page, block.chart, scale));
        }
      } else if (block.kind === 'smallMultiples') {
        for (const panel of block.panels) {
          if (panel.kind === 'waterfall') {
            failures.push(...checkWaterfall(panel));
            failures.push(...checkPlugDisclosure(page, panel, scale));
          }
        }
      }
    }
  }
  return failures;
}

