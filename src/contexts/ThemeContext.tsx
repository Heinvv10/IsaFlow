import { createContext, useCallback, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { log } from '@/lib/logger';
import {
  DEFAULT_THEME_PREFERENCE,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  applyTheme,
  parseThemePreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from '@/lib/theme/themePreference';

interface ThemeContextType {
  /** The theme in effect: the preference with 'system' resolved against the OS. */
  theme: Theme;
  /** What the user chose: Light, Dark or System. */
  preference: ThemePreference;
  /** False until the saved choice has been read; a control should show no selection before then. */
  ready: boolean;
  setPreference: (next: ThemePreference) => void;
  /** Flips the resolved theme into an explicit Light or Dark preference. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * `lightOnly` is true on public / customer-facing routes (isLightOnlyPath, decided by _app from the
 * route): the theme is light there whatever the saved preference says, and the preference is not touched.
 */
export function ThemeProvider({ children, lightOnly = false }: { children: ReactNode; lightOnly?: boolean }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [systemDark, setSystemDark] = useState(false);
  // Nothing touches <html> until the saved choice has been read: public/theme-init.js already
  // applied it before first paint, and applying the default first is what used to overwrite a
  // saved light preference under StrictMode.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setPreferenceState(parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)));
    } catch (error) {
      log.warn('Could not read the saved theme', { error }, 'theme');
    }
    setSystemDark(window.matchMedia(SYSTEM_DARK_QUERY).matches);
    setHydrated(true);
  }, []);

  // Follow the OS live; only matters while the preference is 'system'.
  useEffect(() => {
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme = resolveTheme(preference, systemDark, lightOnly);

  useEffect(() => {
    if (hydrated) applyTheme(document.documentElement, theme);
  }, [hydrated, theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (error) {
      log.warn('Could not save the theme', { error }, 'theme');
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === 'dark' ? 'light' : 'dark');
  }, [setPreference, theme]);

  const value = useMemo(
    () => ({ theme, preference, ready: hydrated, setPreference, toggleTheme }),
    [theme, preference, hydrated, setPreference, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
