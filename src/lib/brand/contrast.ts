/**
 * WCAG 2.1 contrast, and the ONE definition of a brand primary this product
 * accepts. Both gates read it from here: the SAVE gate (brandProfileService)
 * refuses a colour the renderer would not honour, and the RENDER gate
 * (packBrand.safePrimary) substitutes the neutral for a legacy row that
 * predates the save gate. They used to disagree — the save gate demanded white
 * text while the renderer accepted white OR near-black — so a mid tone was
 * refused at save while the renderer held a dark-ink branch no newly-saved row
 * could reach. One predicate is what stops that drifting again.
 */

/** The IsaFlow-neutral primary for a company with no brand_profiles row. */
export const NEUTRAL_BRAND_PRIMARY = '#1a3a5c';

/** The near-black the pack uses when white will not read on the primary. */
export const DARK_INK = '#1a1a1a';

/** WCAG 2.1 AA, SC 1.4.3 (contrast minimum). The primary must carry white OR
 *  near-black text at this ratio; whichever wins becomes `primaryInk`.
 *  Exported because the renderer chooses between the two inks with the same
 *  number — restating it there would let a raised threshold reject a colour at
 *  save while the renderer still put white text on it. */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 2.1 AA, SC 1.4.11 (non-text contrast). The primary must be
 *  distinguishable from the white page at this ratio, or the cover band,
 *  divider bands and table header rows vanish into the paper — a near-white
 *  primary reads fine in black text while the band itself disappears. */
const MIN_BAND_CONTRAST = 3;

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m || m[1] === undefined) throw new Error(`Invalid hex colour: ${hex}`);
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

function linearise(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearise) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Why `hex` cannot be a brand primary, or null when it can. */
export type BrandPrimaryProblem = 'illegible-text' | 'invisible-on-page';

export function brandPrimaryProblem(hex: string): BrandPrimaryProblem | null {
  const toWhite = contrastRatio(hex, '#ffffff');
  const carriesText = toWhite >= MIN_TEXT_CONTRAST || contrastRatio(hex, DARK_INK) >= MIN_TEXT_CONTRAST;
  if (!carriesText) return 'illegible-text';
  if (toWhite < MIN_BAND_CONTRAST) return 'invisible-on-page';
  return null;
}

/** True when `hex` can carry legible text (white or near-black at 4.5:1,
 *  WCAG 2.1 SC 1.4.3) AND is distinguishable from the white page (3:1,
 *  SC 1.4.11). */
export function isUsableBrandPrimary(hex: string): boolean {
  return brandPrimaryProblem(hex) === null;
}

/** Thrown by the save gate. Carries `problem` so the API route can map it to a
 *  400 with an actionable message instead of letting it reach withErrorHandler
 *  as an opaque 500. */
export class BrandPrimaryError extends Error {
  constructor(message: string, readonly problem: BrandPrimaryProblem) {
    super(message);
    this.name = 'BrandPrimaryError';
  }
}

/** The SAVE gate. Validated at save, not at render: by the time a pack renders
 *  there is no UI to warn against, and the failure mode is a client receiving
 *  an unreadable cover. */
export function assertUsableBrandPrimary(hex: string, field: string): void {
  const problem = brandPrimaryProblem(hex);
  if (!problem) return;

  const toWhite = contrastRatio(hex, '#ffffff').toFixed(2);
  const message = problem === 'illegible-text'
    ? `${field} ${hex} carries neither white nor near-black text at the WCAG AA ` +
      `minimum of ${MIN_TEXT_CONTRAST}:1 (${toWhite}:1 against white). ` +
      `Choose a darker or a lighter colour.`
    : `${field} ${hex} has a contrast ratio of ${toWhite}:1 against the white page, ` +
      `below the WCAG AA minimum of ${MIN_BAND_CONTRAST}:1 for a coloured band. ` +
      `Choose a darker colour.`;
  throw new BrandPrimaryError(message, problem);
}
