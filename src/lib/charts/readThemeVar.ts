/**
 * Reads a theme custom property for the chart theme (`buildTheme`'s `getVar`).
 *
 * `--ff-fig-font` is deliberately not defined on screen (styles/globals.css): the board-pack print page
 * defines it, and on screen chart text should be the app face, not buildTheme's server fallback
 * (`ui-monospace`). So when it is empty this answers with the computed face of the app wrapper
 * (`font-sans`: "IsaFlow Figures", DM Sans, ...), which is a valid canvas/SVG font string.
 */
const FIG_FONT = '--ff-fig-font';

export function readThemeVar(styles: CSSStyleDeclaration, name: string): string {
  const value = styles.getPropertyValue(name).trim();
  if (value !== '' || name !== FIG_FONT || typeof document === 'undefined') return value;
  const host = document.querySelector('.font-sans') ?? document.body;
  return getComputedStyle(host).fontFamily;
}
