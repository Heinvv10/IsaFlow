/**
 * WCAG 2.1 contrast, used to refuse a brand colour that cannot carry the cover.
 *
 * Validated at SAVE time, not at render time: by the time a pack renders there
 * is no UI to warn against, and the failure mode is a client receiving a cover
 * with white text on a near-white band.
 */

/** The IsaFlow-neutral primary for a company with no brand_profiles row. */
export const NEUTRAL_BRAND_PRIMARY = '#1a3a5c';

const MIN_RATIO = 4.5;

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

export function assertCarriesWhiteText(hex: string, field: string): void {
  const ratio = contrastRatio(hex, '#ffffff');
  if (ratio < MIN_RATIO) {
    throw new Error(
      `${field} ${hex} has a contrast ratio of ${ratio.toFixed(2)}:1 against white text, ` +
      `below the WCAG AA minimum of ${MIN_RATIO}:1. Choose a darker colour.`,
    );
  }
}
