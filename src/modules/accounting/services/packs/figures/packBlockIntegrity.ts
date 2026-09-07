/**
 * The integrity checks that walk a page's BLOCKS rather than its figures —
 * spec §7.2 checks 4 (each bridge foots) and 6 (a column headed `prior` is
 * filled from prior-period readings), plus the cross-page consistency of the
 * two pages that talk about the same matters.
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
 * ONE QUANTITY, ONE FIGURE, PER PAGE.
 *
 * Sheet 8 of the rendered board pack stated closing cash as `(532)` in its
 * table and `(752)` in the closing-cash line's own title — one page, one
 * quantity, two values, both at R'000, nothing on the page explaining a
 * difference in basis. The gate passed it: `checkColumns` reads a table's
 * columns and `checkWaterfall` reads a bridge's bars, and a chart TITLE is
 * prose that neither of them looks at.
 *
 * So a chart carries the figures its title states, as `claims` (numbers, not
 * a sentence to re-parse), and this holds them against the table on the same
 * page. A claim whose label matches no row is left alone: a chart may state
 * something the page tabulates nowhere.
 *
 * The comparison is on the RAW figures, to the cent. Two readings of closing
 * cash that differ by a rounding step are still a pack that contradicts
 * itself in front of a board; the two windows they were measured over is
 * what actually differed here, and that is not a rounding step.
 */
const CLAIM_TOLERANCE = 0.005;

function tabulatedActuals(page: PackPagesDocument['pages'][number]): Map<string, number> {
  const actuals = new Map<string, number>();
  for (const block of page.blocks) {
    if (block.kind !== 'table') continue;
    for (const row of block.table.rows) {
      const value = row.figures.actual?.value;
      if (value !== null && value !== undefined) actuals.set(row.label, value);
    }
  }
  return actuals;
}

function checkChartClaims(
  page: PackPagesDocument['pages'][number],
  chart: PackChartSpec,
): string[] {
  const actuals = tabulatedActuals(page);
  return (chart.claims ?? []).flatMap((claim) => {
    const tabulated = actuals.get(claim.label);
    if (tabulated === undefined) return [];
    if (Math.abs(tabulated - claim.value) <= CLAIM_TOLERANCE) return [];
    return [
      `Page ${page.number} states '${claim.label}' twice at two values: the table ` +
        `says ${tabulated} and chart '${chart.id}' says ${claim.value}. One page may ` +
        `state one figure for one quantity.`,
    ];
  });
}

/**
 * Checks 4 and 6 and the matters cross-reference, all of which walk the page
 * blocks rather than figures.
 *
 * `scale` is the document's own, narrowed by the caller: the plug disclosure
 * it re-derives prints a rand amount, and a sentence built at a different
 * scale from the one the page printed would never match the page's text —
 * the gate would refuse a pack that says exactly what it must.
 */
/**
 * THE ACTION PANEL AND THE MATTERS TABLE ARE ONE LIST, AND THE DOCUMENT MUST
 * SAY SO.
 *
 * Page 4 told the board "23 further matters follow on the matters page" and
 * page 11 printed six, disclosing twenty-two that follow nowhere; page 4
 * named JE-2026-00002 as a top matter and page 11 did not list it at all.
 * Each page was internally correct. The cross-reference between them was
 * false, in the governance section, two sheets apart — which is the one
 * defect class a reader cannot check and a gate can.
 *
 * `selectPrintedMatters` now makes ONE selection that both pages read, so
 * this cannot drift by accident. It is asserted anyway, on the COMPOSED
 * document, because that is the artefact a director receives and because the
 * next author to give page 4 its own ranking would otherwise reintroduce it
 * silently.
 *
 * Structural, not a prose match: a bullet is matched against a printed
 * matter's `issue` exactly, or as `<issue> — <decision>`; the two derived
 * summary sentences are the ALLOW-LIST, and each carries the count it must
 * carry. The counts are required rather than merely checked when present —
 * a reworded sentence makes this red, not vacuous.
 */
const FOLLOW_ON = /^(\d+) further matters? follows? on the matters page\./;
const NOT_PRINTED = /^(\d+) further matters? (?:is|are) not printed in this pack;/;
const SAME_DECISION = /^Each of these needs the same decision: /;

export function checkMattersCrossReference(doc: PackPagesDocument): string[] {
  const blocks = doc.pages.flatMap((page) => page.blocks);
  const table = blocks.find((b) => b.kind === 'matters');
  const panel = blocks.find((b) => b.kind === 'narrative' && b.boardActions !== undefined);
  if (table === undefined || table.kind !== 'matters') return [];
  if (panel === undefined || panel.kind !== 'narrative' || panel.boardActions === undefined) return [];

  const printed = table.matters.map((m) => m.issue);
  const omittedCount = table.omitted?.count ?? 0;
  const failures: string[] = [];

  let named = 0;
  let followOn: number | null = null;
  let notPrinted: number | null = null;
  for (const item of panel.boardActions) {
    const follow = FOLLOW_ON.exec(item);
    if (follow !== null) { followOn = Number(follow[1]); continue; }
    const rest = NOT_PRINTED.exec(item);
    if (rest !== null) { notPrinted = Number(rest[1]); continue; }
    if (SAME_DECISION.test(item)) continue;

    named += 1;
    const onTable = printed.some((issue) => item === issue || item.startsWith(`${issue} — `));
    if (!onTable) {
      failures.push(
        `The action panel names a matter the matters page does not list: "${item}". `
          + `Both pages are derived from the same checks and a director cannot look this one up.`,
      );
    }
  }

  const expectedFollowOn = printed.length - named;
  if (expectedFollowOn > 0 && followOn !== expectedFollowOn) {
    failures.push(
      `The action panel says ${followOn ?? 'nothing'} about how many further matters follow on the `
        + `matters page; that page lists ${printed.length} and the panel names ${named}, so ${expectedFollowOn} follow.`,
    );
  }
  if (omittedCount > 0 && notPrinted !== omittedCount) {
    failures.push(
      `The action panel says ${notPrinted ?? 'nothing'} about matters not printed in this pack; `
        + `the matters page discloses ${omittedCount}.`,
    );
  }
  return failures;
}

export function checkBlocks(doc: PackPagesDocument, scale: MoneyScale): string[] {
  const failures: string[] = [...checkMattersCrossReference(doc)];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'table') {
        failures.push(...checkColumns(block.table, `Page ${page.number} table`));
      } else if (block.kind === 'chart') {
        failures.push(...checkChartClaims(page, block.chart));
        if (block.chart.kind === 'waterfall') {
          failures.push(...checkWaterfall(block.chart));
          failures.push(...checkPlugDisclosure(page, block.chart, scale));
        }
      } else if (block.kind === 'smallMultiples') {
        for (const panel of block.panels) {
          failures.push(...checkChartClaims(page, panel));
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

