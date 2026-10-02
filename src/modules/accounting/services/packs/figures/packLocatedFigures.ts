/**
 * Every figure a pack page prints, and where in the document it was found —
 * the walk the integrity gate's figure-level checks read. Moved out of
 * `packFigureIntegrity.ts` unchanged to keep that file under the 300-line
 * cap.
 */

import type { PackFigure } from './packFigureProvenance';
import type { PackPagesDocument } from '../pages/packPageModel';

/** A figure and where in the document it was found, for the failure message. */
export interface Located {
  figure: PackFigure;
  where: string;
}

/**
 * Every figure a page actually prints.
 *
 * EXHAUSTIVE BY CONSTRUCTION, and it was not. It ended `default: break`, so a
 * new figure-bearing block kind would have been collected by nothing,
 * resolved against no provenance and recomputed by no quotient check — and
 * §7.2's first rule is that EVERY figure on EVERY page resolves through
 * provenance. It was true only by coincidence of the block list: the four
 * kinds that carry no `PackFigure` today happen to be the four the switch
 * fell through to. Adding a fifth would have been silent.
 *
 * The kinds with no figure are now named, with where their numbers ARE
 * checked, and the fall-through is a `never` — the same fix `blockMm` and
 * `adoptBlock` already use, and the reason is the same: a new block kind
 * should not compile until someone has decided where its figures are checked.
 */
export function locateFigures(doc: PackPagesDocument): Located[] {
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
          // AND THE EXPOSURE THE PAGE STATES FOR THE ONES IT DID NOT PRINT.
          // It is a money figure in the page's own words — "N further matters
          // … totalling X" — so §7.2's first rule admits no exception for it
          // either. `checkBlocks` already foots it against the printed rows;
          // this is what resolves it against the service that issued it.
          if (block.omitted !== null) {
            found.push({ figure: block.omitted.quantum, where: at('matters omission note') });
          }
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
        // NO `PackFigure` ON THESE FOUR, and each says where its numbers go
        // instead. A chart's arithmetic is bars, checked by `checkBlocks` and
        // `checkWaterfall`; a narrative and a disclosure carry prose, checked
        // by `checkProse`. Listed rather than defaulted so that a fifth kind
        // is a compile error here.
        case 'chart':
        case 'smallMultiples':
        case 'narrative':
        case 'disclosure':
          break;
        default: {
          const unknownKind: never = block;
          throw new Error(
            'locateFigures: a block kind was added without deciding where its figures are '
              + `checked — ${JSON.stringify((unknownKind as { kind?: unknown }).kind)}. `
              + 'Spec §7.2: every figure on every page resolves through provenance.',
          );
        }
      }
    }
  }
  return found;
}
