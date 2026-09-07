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

import { toMoneyScale } from '@/lib/format/money';
import type { PackFigure } from './packFigureProvenance';
import type { PackPagesDocument } from '../pages/packPageModel';
import {
  checkCashBridgeEndpoints,
  checkComparativePeriod,
  checkStatements,
} from './packStatementIntegrity';
import { checkBlocks } from './packBlockIntegrity';
import { checkProse } from './packProseIntegrity';

/** One basis point, in the percentage POINTS a `pct` figure is stated in. */
const PCT_TOLERANCE = 0.01;
/**
 * Half the last printed digit, plus the second rounding.
 *
 * `reportingEngineService` rounds a ratio TWICE — `safeDiv` to four decimals
 * and then `r2` to two — so the printed value can sit 0.00505 from the true
 * quotient (0.724951 becomes 0.7250 becomes 0.73). A flat half-unit (0.005)
 * would refuse a ratio computed exactly as the engine computes it; this is
 * that half-unit plus the 0.00005 the first rounding can add, nudged up by a
 * hair so a difference landing exactly on the bound is not refused by the way
 * a float represents it. It is deliberately NOT a round 0.01: a ratio prints
 * to two decimals, so an error of 0.009 shows 0.73 where the truth is 0.74 —
 * visible on the page, and not something this gate should pass.
 */
const RATIO_TOLERANCE = 0.0051;

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
        case 'matters':
          for (const matter of block.matters)
            found.push({ figure: matter.quantum, where: at(`matter '${matter.issue.slice(0, 40)}'`) });
          break;
        case 'definitions':
          for (const entry of block.entries)
            for (const step of entry.reconciliation ?? []) {
              found.push({ figure: step.figure, where: at(`'${entry.term}' reconciliation '${step.label}'`) });
              // The comparative column is a printed figure like any other, so
              // it is traced like any other. A bridge column outside the gate
              // is a column that can print a number no service issued.
              if (step.comparative !== undefined) {
                found.push({
                  figure: step.comparative,
                  where: at(`'${entry.term}' reconciliation '${step.label}' comparative`),
                });
              }
            }
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
    if (value === null) continue;
    if (seen.has(source)) continue;
    seen.add(source);

    // A quotient that prints a number and cannot say which two figures
    // produced it (I-1). The gate refuses a `money` figure carrying a basis
    // as unrecomputable; accepting a percentage carrying NONE is the same
    // hole from the other side, and it is the larger one — seven live
    // figures, including current ratio, cash ratio and debt-to-equity, went
    // unrecomputed because the check only fired on figures that had already
    // volunteered their working. 'days' is deliberately not a quotient
    // format here: a day count is a rate multiplied by a period length
    // (`receivables / revenue * 365`), so it has no numerator-over-
    // denominator the gate could reproduce without inventing a third term.
    if (basis === undefined) {
      if (format === 'pct' || format === 'ratio') {
        failures.push(
          `${where}: '${source}' prints ${value} as a ${format} but states ` +
            `no numerator and denominator, so nothing can recompute it. A ` +
            `quotient the pack cannot explain is refused.`,
        );
      }
      continue;
    }

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
  // 7. The pack does not show a reader how it is built. Six leaks on the
  //    rendered proofs — a column name, a spec clause, three `(s)` plurals, a
  //    millisecond timestamp — were one defect: prose written for a developer
  //    on the paths a flattering fixture never reaches. See
  //    `packProseIntegrity.ts`.
  failures.push(...checkProse(doc));

  // The document's own scale, narrowed. An unrecognised one is refused rather
  // than defaulted: every figure on the pack is FORMATTED at this scale, and
  // printing rands under a header that claims thousands is the 1000x misread
  // (R-P52) the whole mechanism exists to stop.
  const scale = toMoneyScale(doc.numberConvention.scale);
  if (scale === null) {
    failures.push(
      `The pack states its figures in '${doc.numberConvention.scale}', which is not a scale ` +
        `any formatter knows. Refusing to print figures at an unknown scale.`,
    );
  } else {
    failures.push(...checkBlocks(doc, scale));
  }

  if (failures.length > 0) {
    throw new Error(
      `Pack figure integrity failed, so this render is refused (spec §7.2). ` +
        `${failures.length} problem${failures.length === 1 ? '' : 's'}:\n  ` +
        failures.join('\n  '),
    );
  }
}
