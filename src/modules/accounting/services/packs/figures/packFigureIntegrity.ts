/**
 * The gate that refuses to render a pack whose figures do not reconcile.
 *
 * Spec §7.2, and it FAILS THE RENDER rather than warning. A warning on a
 * document a director forwards to their bank is a warning nobody reads: it
 * lands in a log the author has already stopped looking at, while the pack
 * goes out with the defect in it. `buildBoardPackPages` calls this as its last
 * act, so a pack that does not foot never becomes a document at all.
 *
 * WHAT IT CHECKS, and against what:
 *   1. Every figure printed on a page resolves through the provenance map, at
 *      the value the page carries. A figure a component invented has no
 *      source to find and fails here.
 *   2. The same source, rendered twice in one pack, renders identically —
 *      `PackFigureProvenance.assertConsistent`, whose comparison is exact by
 *      ruling (R-P27). Packs COPY figures from services; two readings of one
 *      source differing at all means someone did arithmetic in a page.
 *   3. The statements foot. Assets equal liabilities plus equity, and each
 *      derived subtotal equals the figures it was derived from.
 *   4. Each bridge chart's bars reach the endpoint it claims — see
 *      `packWaterfallIntegrity`, which owns the subtotal-aware walk.
 *   5. Every percentage recomputes from its own stated numerator and
 *      denominator, to within a basis point.
 *   6. A column headed `prior` is filled from prior-period readings, and the
 *      actual column is not — and the period that column CLAIMS in its header
 *      is the period those figures were read over (R-P55). The two fail
 *      differently: right data under a wrong label is a lie no provenance
 *      check can see.
 *
 * A NULL FIGURE IS NOT A FAILED CHECK. `unavailable` carries the reason a
 * figure is not meaningful (R-P44/R-P45) — a margin on nil turnover, an
 * opening balance in a first period. Those are skipped by the arithmetic
 * checks, deliberately: treating "not meaningful" as "wrong" would fail the
 * one pack shape the model went to some trouble to state honestly.
 *
 * TOLERANCES. One cent on money, one basis point on a percentage — enough to
 * absorb IEEE-754 wobble in a sum of rands, far too little to absorb a
 * mis-stated figure. They are NOT the same thing as R-P27's exactness above,
 * which governs two readings of ONE source and stays exact.
 */

import type { PackFigure } from './packFigureProvenance';
import type { PackPagesDocument } from '../pages/packPageModel';
import { checkWaterfall } from './packWaterfallIntegrity';
import {
  checkCashBridgeEndpoints,
  checkColumns,
  checkComparativePeriod,
  checkStatements,
} from './packStatementIntegrity';

/** One basis point, in the percentage POINTS a `pct` figure is stated in. */
const PCT_TOLERANCE = 0.01;
/** A ratio is printed to two decimals, so half of the last printed digit. */
const RATIO_TOLERANCE = 0.005;

/** A figure and where in the document it was found, for the failure message. */
interface Located {
  figure: PackFigure;
  where: string;
}

/** Every figure a page actually prints. Charts carry no `PackFigure`; their
 *  arithmetic is checked as bars instead. */
function locateFigures(doc: PackPagesDocument): Located[] {
  const found: Located[] = [];
  for (const page of doc.pages) {
    const at = (what: string): string => `page ${page.number} ${what}`;
    for (const block of page.blocks) {
      switch (block.kind) {
        case 'kpiTiles':
          for (const tile of block.tiles) found.push({ figure: tile.figure, where: at(`tile '${tile.label}'`) });
          break;
        case 'statTiles':
          for (const group of block.groups)
            for (const stat of group.stats) found.push({ figure: stat.figure, where: at(`stat '${stat.label}'`) });
          break;
        case 'table':
          for (const row of block.table.rows)
            for (const [column, figure] of Object.entries(row.figures))
              if (figure) found.push({ figure, where: at(`table row '${row.label}' column '${column}'`) });
          break;
        case 'scorecard':
          for (const group of block.groups)
            for (const row of group.rows) {
              found.push({ figure: row.actual, where: at(`scorecard '${row.metric}' actual`) });
              if (row.prior) found.push({ figure: row.prior, where: at(`scorecard '${row.metric}' prior`) });
            }
          break;
        case 'definitions':
          for (const entry of block.entries)
            for (const step of entry.reconciliation ?? [])
              found.push({ figure: step.figure, where: at(`'${entry.term}' reconciliation '${step.label}'`) });
          break;
        default:
          break;
      }
    }
  }
  return found;
}

/** Check 1 — a page figure that no service issued has nothing behind it. */
function checkResolution(doc: PackPagesDocument, located: Located[]): string[] {
  const recorded = doc.provenance.all();
  const failures: string[] = [];
  for (const { figure, where } of located) {
    const issued = recorded.get(figure.source);
    if (issued === undefined) {
      failures.push(
        `${where} prints '${figure.source}', which no service issued through ` +
          `the provenance map. A figure with no recorded source was computed ` +
          `in a page.`,
      );
      continue;
    }
    if (!issued.some((f) => f.value === figure.value && f.unavailable === figure.unavailable)) {
      failures.push(
        `${where} prints ${String(figure.value)} for '${figure.source}', which ` +
          `the provenance map never recorded. The page and the record disagree.`,
      );
    }
  }
  return failures;
}

/** Check 5 — a printed percentage that its own numerator and denominator do
 *  not reproduce is a number the pack cannot explain. */
function checkQuotients(located: Located[]): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const { figure, where } of located) {
    const { basis, value, format, source } = figure;
    if (basis === undefined || value === null) continue;
    if (seen.has(source)) continue;
    seen.add(source);

    if (format !== 'pct' && format !== 'ratio') {
      failures.push(
        `${where}: '${source}' is a '${format}' figure carrying a numerator ` +
          `and denominator. Only a percentage or a ratio is a quotient, so ` +
          `this one cannot be recomputed and is refused.`,
      );
      continue;
    }
    if (basis.denominator === 0) {
      failures.push(
        `${where}: '${source}' states a denominator of zero, so the ${value} ` +
          `it prints cannot recompute from it.`,
      );
      continue;
    }
    const quotient = basis.numerator / basis.denominator;
    const expected = format === 'pct' ? quotient * 100 : quotient;
    const tolerance = format === 'pct' ? PCT_TOLERANCE : RATIO_TOLERANCE;
    if (Math.abs(value - expected) > tolerance) {
      failures.push(
        `${where}: '${source}' prints ${value} but does not recompute from ` +
          `its stated basis — ${basis.numerator} over ${basis.denominator} ` +
          `is ${expected}.`,
      );
    }
  }
  return failures;
}

/** Checks 4 and 6, both of which walk the page blocks rather than figures. */
function checkBlocks(doc: PackPagesDocument): string[] {
  const failures: string[] = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'table') {
        failures.push(...checkColumns(block.table, `Page ${page.number} table`));
      } else if (block.kind === 'chart') {
        if (block.chart.kind === 'waterfall') failures.push(...checkWaterfall(block.chart));
      } else if (block.kind === 'smallMultiples') {
        for (const panel of block.panels) {
          if (panel.kind === 'waterfall') failures.push(...checkWaterfall(panel));
        }
      }
    }
  }
  return failures;
}

/**
 * Refuse to render a pack whose figures do not reconcile.
 *
 * Reports EVERY failure rather than the first, for the reason
 * `assertConsistent` does: a pack that has drifted has usually drifted in more
 * than one place, and one failure per fix-and-rerun cycle wastes the author's
 * day.
 *
 * @throws when any check fails. The throw is the point — see the file header.
 */
export function assertPackIntegrity(doc: PackPagesDocument): void {
  const located = locateFigures(doc);
  const failures: string[] = [];

  try {
    doc.provenance.assertConsistent();
  } catch (error) {
    // Its message already names every disagreeing source; it is folded in
    // here so one render reports every integrity failure at once.
    failures.push(error instanceof Error ? error.message : String(error));
  }

  failures.push(...checkResolution(doc, located));
  failures.push(...checkStatements(doc));
  failures.push(...checkQuotients(located));
  failures.push(...checkCashBridgeEndpoints(doc));
  failures.push(...checkComparativePeriod(doc));
  failures.push(...checkBlocks(doc));

  if (failures.length > 0) {
    throw new Error(
      `Pack figure integrity failed, so this render is refused (spec §7.2). ` +
        `${failures.length} problem${failures.length === 1 ? '' : 's'}:\n  ` +
        failures.join('\n  '),
    );
  }
}
