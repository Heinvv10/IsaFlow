/**
 * ECharts theme built from the app's `--ff-*` CSS custom properties.
 *
 * `getVar` is injected (rather than reading `document` directly) so this is
 * testable without a DOM, and so the caller controls when/where styles are
 * read (see `EChart.tsx`, which reads `getComputedStyle(document.documentElement)`).
 *
 * Fallbacks below cover two of the `--ff-*` tokens not yet defined in
 * `styles/globals.css` at the time this wrapper was written (`--ff-fav`,
 * `--ff-unfav`, `--ff-prior`, `--ff-plan`, `--ff-fig-font`) as well as the
 * three that already exist, so the chart never renders with empty-string
 * colours if `getVar` can't resolve a property.
 */

const FALLBACK = {
  ink: '#15202b',
  textTertiary: '#9ca3af',
  borderLight: '#e5e7eb',
  fav: '#1f7a4d',
  unfav: '#b23a3a',
  prior: '#c9d0cc',
  plan: '#8a94a0',
  figFont: 'ui-monospace, monospace',
} as const;

export interface EChartsTheme {
  color: [string, string, string];
  textStyle: { fontFamily: string };
  categoryAxis: {
    axisLine: { lineStyle: { color: string } };
    axisLabel: { color: string };
  };
  valueAxis: {
    axisLine: { lineStyle: { color: string } };
    axisLabel: { color: string };
  };
  favColor: string;
  unfavColor: string;
}

export function buildTheme(getVar: (name: string) => string): EChartsTheme {
  const ink = getVar('--ff-text-primary') || FALLBACK.ink;
  const textTertiary = getVar('--ff-text-tertiary') || FALLBACK.textTertiary;
  const borderLight = getVar('--ff-border-light') || FALLBACK.borderLight;
  const fav = getVar('--ff-fav') || FALLBACK.fav;
  const unfav = getVar('--ff-unfav') || FALLBACK.unfav;
  const prior = getVar('--ff-prior') || FALLBACK.prior;
  const plan = getVar('--ff-plan') || FALLBACK.plan;
  const figFont = getVar('--ff-fig-font') || FALLBACK.figFont;

  const buildAxis = () => ({
    axisLine: { lineStyle: { color: borderLight } },
    axisLabel: { color: textTertiary },
  });

  return {
    color: [ink, prior, plan],
    textStyle: { fontFamily: figFont },
    categoryAxis: buildAxis(),
    valueAxis: buildAxis(),
    favColor: fav,
    unfavColor: unfav,
  };
}
