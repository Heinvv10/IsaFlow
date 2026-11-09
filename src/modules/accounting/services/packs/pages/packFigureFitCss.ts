/**
 * THE FIGURE SIZE A ROW PRINTS AT, AS THE PAGE CARRIES IT: no measuring here. The fit is decided once, on the server,
 * when the pack is composed (`packFigureFitStamp.stampFigureFits`, from `packFigureFit`), and travels on the block; the
 * components only turn it into markup. So the size printed is the size the floor gate checked, and nothing that shapes
 * text (`packGlyphRuler`, fontkit, the font files) reaches the browser bundle.
 *
 * A page prints only a STAMPED document (`StampedPackPagesDocument`): every statement table and KPI row carries a fit
 * that fits, at a size the fit model can decide. Anything else (no fit, `fits: false`, a size outside the range) is
 * refused where the document is adopted (`packDocumentWire`) and again where it is rendered (`unstampedFigure`), and
 * the page says why (`markPrintError('pages')`) rather than printing a row nobody checked.
 */
import { printsAnywhere } from './packPrintedText';
import type { PackPage, PackPageBlock, PackPagesDocument, PackTable } from './packPageModel';

export interface FigureFit {
  /** The whole-pixel size to set, or null where the row fits at its ordinary size and nothing is set. */
  px: number | null;
  /** False where it fits at no size down to the floor (the composer refuses such a pack: `packFigureFloor`). */
  fits: boolean;
  /**
   * A statement table's only, and only where a row label prints anywhere (`printsAnywhere`): the `min-width` in whole
   * pixels each such label is printed at, the widest any of its graphemes can be (`packAnywhereLabel.anywhereFloorPx`), which the fit
   * counted in the label column's min-content. The print cannot break inside a grapheme, so without it a wide one
   * runs over the figures.
   */
  labelFloorPx?: number;
}

/** The ordinary and smallest figure sizes, in points: 22pt / 12pt KPI figures, 9pt / 7.5pt table figures. */
export const KPI_FIGURE_MAX_PT = 22;
export const KPI_FIGURE_FLOOR_PT = 12;
export const TABLE_FIGURE_MAX_PT = 9;
export const TABLE_FIGURE_FLOOR_PT = 7.5;

const pt = (value: number): number => (value * 96) / 72;

/**
 * The sizes the fit model tries, in px: from the ordinary size down to the floor, whole pixels. A table's ordinary
 * size is 12px (9pt) and a fit at it is stated as `px: null`; a KPI row's is 29.33px (22pt), so its largest stated
 * size is 29px.
 */
export const FIT_PX = {
  table: { ordinary: Math.round(pt(TABLE_FIGURE_MAX_PT)), floor: Math.round(pt(TABLE_FIGURE_FLOOR_PT)) },
  kpi: { ordinary: pt(KPI_FIGURE_MAX_PT), floor: Math.round(pt(KPI_FIGURE_FLOOR_PT)) },
} as const;

export type FitKind = keyof typeof FIT_PX;

/** The largest size a fit of `kind` may state (anything at or above the ordinary size is `px: null`). */
const statedCeiling = (kind: FitKind): number => (kind === 'table' ? FIT_PX.table.ordinary - 1 : Math.floor(FIT_PX.kpi.ordinary));


/** Is `value` a fit the server could have stamped on a printable `kind` row: it fits, at null or a whole size in range? */
export function isFigureFit(value: unknown, kind: FitKind): value is FigureFit {
  if (typeof value !== 'object' || value === null) return false;
  const { px, fits, labelFloorPx } = value as Record<string, unknown>;
  if (fits !== true) return false;
  if (labelFloorPx !== undefined && (kind !== 'table' || typeof labelFloorPx !== 'number' || !Number.isInteger(labelFloorPx) || labelFloorPx < 1)) return false;
  return px === null || (typeof px === 'number' && Number.isInteger(px) && px >= FIT_PX[kind].floor && px <= statedCeiling(kind));
}

/**
 * The CSS a fitted `kind` row carries; empty where the row fits at its ordinary size (the markup is then what it always
 * was). Throws on a fit the server could not have stamped on a printable row: nothing prints at a size nobody checked.
 */
export function fitAttributes(fit: FigureFit, kind: FitKind): { className?: string; style?: Record<string, string> } {
  if (!isFigureFit(fit, kind)) throw new Error(`fitAttributes: refusing to print a ${kind} row at a figure size the server did not decide (${JSON.stringify(fit ?? null)})`);
  return fit.px === null ? {} : { className: 'is-fitted', style: { '--pack-fit-size': `${fit.px}px` } };
}

/**
 * The `min-width`, in pixels, a statement table's label printed to break anywhere is set at: the floor the server
 * counted in the fit (`FigureFit.labelFloorPx`). Throws where there is none: such a label would run over the figures.
 */
export function anywhereFloor(fit: FigureFit): number {
  if (fit.labelFloorPx === undefined) throw new Error('anywhereFloor: refusing to print a label printed to break anywhere without the floor the server decided for it');
  return fit.labelFloorPx;
}

/** A statement table as a page prints it: with its fit. */
export type StampedPackTable = PackTable & { figureFit: FigureFit };

type Stamp<B> = B extends { kind: 'table' } ? Omit<B, 'table'> & { table: StampedPackTable }
  : B extends { kind: 'kpiTiles' } ? B & { fit: FigureFit } : B;

/** A block as a page prints it: a table or KPI row with its fit. */
export type StampedPackPageBlock = Stamp<PackPageBlock>;
export type StampedPackPage = Omit<PackPage, 'blocks'> & { blocks: StampedPackPageBlock[] };
export type StampedPackPagesDocument = Omit<PackPagesDocument, 'pages'> & { pages: StampedPackPage[] };

/** Why `block` cannot print as stamped, or null where it can. */
export function unstampedBlock(block: PackPageBlock): string | null {
  if (block.kind === 'table' && !isFigureFit(block.table.figureFit, 'table')) {
    return `a statement table without a printable figure size (${JSON.stringify(block.table.figureFit ?? null)})`;
  }
  if (block.kind === 'table' && block.table.figureFit!.labelFloorPx === undefined && block.table.rows.some((row) => printsAnywhere(row.label))) {
    return 'a statement table with a label printed to break anywhere and no floor for it (labelFloorPx)';
  }
  if (block.kind === 'kpiTiles' && !isFigureFit(block.fit, 'kpi')) {
    return `a KPI row without a printable figure size (${JSON.stringify(block.fit ?? null)})`;
  }
  return null;
}

/** Why `doc` cannot print as stamped (the first block that is not), or null where every block can. */
export function unstampedFigure(doc: { pages: ReadonlyArray<{ number: number; blocks: readonly PackPageBlock[] }> }): string | null {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      const why = unstampedBlock(block);
      if (why !== null) return `page ${page.number}: ${why}`;
    }
  }
  return null;
}

/** `doc`, typed as stamped, once every block has been checked; throws with the first that is not. */
export function asStamped(doc: PackPagesDocument): StampedPackPagesDocument {
  const why = unstampedFigure(doc);
  if (why !== null) throw new Error(`refusing to print ${why}: the server decides every figure size (packFigureFitStamp)`);
  return doc as StampedPackPagesDocument;
}
