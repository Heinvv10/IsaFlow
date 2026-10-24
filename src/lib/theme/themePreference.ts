/**
 * Colour-theme preference: Light / Dark / System. Pure decision logic only; the React glue lives
 * in ThemeContext. public/theme-init.js repeats resolveTheme (it runs before first paint, outside
 * the bundle) and is held to it by tests/unit/components/theme/themePreference.test.tsx.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'accounting-theme';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The saved preference, or the default when nothing valid is saved. */
export function parseThemePreference(saved: string | null): ThemePreference {
  return isThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
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
}
