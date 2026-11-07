/**
 * THE FIGURE SIZE A ROW PRINTS AT, AS THE PAGE CARRIES IT: no measuring here. The fit is decided once, on the server,
 * when the pack is composed (`packFigureFitStamp.stampFigureFits`, from `packFigureFit`), and travels on the block; the
 * components only turn it into markup. So the size printed is the size the floor gate checked, and nothing that shapes
 * text (`packGlyphRuler`, fontkit, the font files) reaches the browser bundle.
 */

export interface FigureFit {
  /** The whole-pixel size to set, or null where the row fits at its ordinary size and nothing is set. */
  px: number | null;
  /** False where it fits at no size down to the floor. */
  fits: boolean;
}

/** The CSS a fitted row carries; empty where the row fits at its ordinary size (the markup is then what it always was). */
export function fitAttributes(fit: FigureFit): { className?: string; style?: Record<string, string> } {
  return fit.px === null ? {} : { className: 'is-fitted', style: { '--pack-fit-size': `${fit.px}px` } };
}

/** Is `value` a figure fit as the server stamps it? (The wire adopter refuses a block without one.) */
export function isFigureFit(value: unknown): value is FigureFit {
  if (typeof value !== 'object' || value === null) return false;
  const { px, fits } = value as Record<string, unknown>;
  return typeof fits === 'boolean' && (px === null || (typeof px === 'number' && Number.isInteger(px) && px > 0));
}
