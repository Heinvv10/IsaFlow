/**
 * Colour-theme preference: Light / Dark / System. Pure decision logic only; the React glue lives
 * in ThemeContext. public/theme-init.js repeats resolveTheme (it runs before first paint, outside
 * the bundle) and is held to it by tests/unit/components/theme/themePreference.test.tsx.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'accounting-theme';
/**
 * What a user with no saved choice gets. Dark, on purpose: it is what every existing user has
 * been seeing, and changing it would flip the app under them. Only an explicit choice (Light,
 * Dark or System in the header) is ever written to storage.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The saved preference, or the default when nothing valid is saved. */
export function parseThemePreference(saved: string | null): ThemePreference {
  return isThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE;
}

/**
 * Public and customer-facing surfaces (the client portal, share links, the auditor portal, the AFS
 * signing and director portal) are always light: they are documents a third party reads, and nobody
 * there chose a theme. public/theme-init.js repeats this list; a test holds the two together.
 */
const LIGHT_ONLY_PATHS: RegExp[] = [
  /^\/portal(\/|$)/,
  /^\/share(\/|$)/,
  /^\/audit-portal(\/|$)/,
  /^\/accounting\/afs\/(sign|portal)(\/|$)/,
];

export function isLightOnlyPath(pathname: string): boolean {
  return LIGHT_ONLY_PATHS.some((re) => re.test(pathname));
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean, lightOnly = false): Theme {
  if (lightOnly) return 'light';
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

/**
 * `dark` class for Tailwind and CSS `color-scheme` so the browser draws native controls
 * (select and date pop-ups, scrollbars) in the same theme.
 */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.setProperty('color-scheme', theme);
  // Set only by the provider (theme-init.js does not): tests wait on it to know hydration has applied the theme.
  root.dataset.themeApplied = theme;
}
