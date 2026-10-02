/**
 * EBITDA's sources, the one wording of its add-back, and the note that says
 * when the printed bridge does not add as printed. Split out of
 * `packDefinitions.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { formatMoney, MONEY_SCALES } from '@/lib/format/money';
import { PACK_SCALE } from './packScale';

/** The source page 5's EBITDA row already records. Restated here so the
 *  reconciliation's closing line and the table's cell are ONE figure — two
 *  sources for one number is what `assertConsistent` exists to refuse. */
export const EBITDA_SOURCE = 'calculateExtendedRatios.ebitda';

/**
 * WHAT EBITDA ADDS BACK, IN THE PACK'S ONE WORDING.
 *
 * Page 5 said "plus the MOVEMENT on depreciation and amortisation" and page
 * 12's ordinary arm said "plus the depreciation and amortisation CHARGED in
 * the period" — the same measure defined two ways inside one document, and
 * the basis page defining it in words its own page 5 does not use. Both give
 * +77 on the demo company, so nothing was disproved by it; on Brightsphere
 * the movement is a net credit of (152) and "charged" would be false. Page
 * 12's credited arm already said "movement" for exactly that reason, so the
 * document held both wordings at once and one of them could not travel.
 *
 * "Movement" is correct in both directions and is what every page says now.
 * Short — without "the period's" — because page 5 measured it: the longer
 * form breaks differently and costs that sheet a line, which the fitter pays
 * for out of a note. The period is already the subject of both sentences.
 */
export const DA_ADD_BACK = 'the movement on depreciation and amortisation';
export const DEPRECIATION_SOURCE = 'packFigureSet.current.depreciation';

/** A raw rand amount as the page PRINTS it — the unit a reader adds. Half
 *  away from zero, which is what `Intl.NumberFormat` does inside
 *  `formatMoney`, so this cannot disagree with the cell beside it. */
function atPackScale(rands: number): number {
  return Math.sign(rands) * Math.round(Math.abs(rands) / MONEY_SCALES[PACK_SCALE]);
}

/**
 * THE ONE TABLE IN A BOARD PACK WHOSE JOB IS TO ADD, SAYING SO WHEN IT DOES
 * NOT ADD AS PRINTED.
 *
 * The three lines are unrounded rands and each is rounded to the nearest
 * R'000 on its own, so the sum of the roundings and the rounding of the sum
 * differ by a unit whenever the fractions carry it: the live demo pack printed
 * operating profit (1 545), an add-back of 77 and EBITDA of (1 467), where the
 * printed operands give (1 468). Nothing is wrong with any of the three
 * figures, and page 12 already carries a general rounding note — but a
 * director invited to foot a non-IFRS bridge should not have to reach for a
 * caveat in another column to make it work. This states it on the line, in the
 * unrounded figures, so the arithmetic is visibly right rather than merely
 * derivable.
 *
 * Null where the printed lines add, which is most packs — a note explaining a
 * discrepancy a reader cannot find is worse than no note.
 */
export function bridgeRoundingNote(operating: number, addBack: number, ebitda: number): string | undefined {
  if (atPackScale(operating) + atPackScale(addBack) === atPackScale(ebitda)) return undefined;
  const exact = (n: number) => formatMoney(n, { cents: true, pack: true });
  // IN RANDS, AND IT SAYS SO. Every other figure on this page is in R'000,
  // and three unrounded amounts printed beside them with no unit named is a
  // fourth way of reading the same column.
  return `The three lines above are each rounded to the nearest ${PACK_SCALE}, so they differ by `
    + `one unit from their own sum. In rands: ${exact(operating)} plus ${exact(addBack)} is `
    + `${exact(ebitda)}.`;
}

/**
 * THE SAME NOTE OVER TWO COLUMNS, because the bridge now carries two.
 *
 * Either column may fail to foot as printed and they fail independently, so
 * the note names WHICH one it is explaining. A reader looking at the column
 * that does add must not be told it does not.
 */
export function bridgeRoundingNotes(
  current: { operating: number; addBack: number; ebitda: number },
  comparative: { operating: number; addBack: number; ebitda: number } | null,
): string | undefined {
  const currentNote = bridgeRoundingNote(current.operating, current.addBack, current.ebitda);
  const priorNote = comparative === null
    ? undefined
    : bridgeRoundingNote(comparative.operating, comparative.addBack, comparative.ebitda);
  if (currentNote === undefined && priorNote === undefined) return undefined;
  if (comparative === null) return currentNote;
  // NAMED, once there are two columns to confuse. A bare "the three lines
  // above" over a two-column bridge does not say which three.
  if (currentNote !== undefined && priorNote !== undefined) {
    return `Reporting period: ${currentNote} Comparative period: ${priorNote}`;
  }
  return currentNote !== undefined
    ? `Reporting period: ${currentNote}`
    : `Comparative period: ${priorNote}`;
}
