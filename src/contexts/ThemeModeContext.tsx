/**
 * ThemeModeContext — the practitioner/client visual axis.
 * Writes `data-theme` onto <html> so the CSS token overrides in globals.css
 * apply. Modeled on TableDensityContext (localStorage-persisted UI preference).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type ThemeMode,
  THEME_MODE_STORAGE_KEY,
  isThemeMode,
  resolveThemeMode,
} from '@/lib/theme/themeMode';

interface ThemeModeContextType {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextType | undefined>(undefined);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('practitioner');

  // Hydrate from the persisted user override (client-only).
  // Phase 1 has no role-based default; a future phase will resolve from
  // CompanyContext role via resolveThemeMode's companyRole input.
  useEffect(() => {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    const resolved = resolveThemeMode({ override: isThemeMode(saved) ? saved : undefined });
    setModeState(resolved);
  }, []);

  // Reflect onto <html> so CSS [data-theme='client'] applies.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeModeContextType>(() => ({ mode, setMode }), [mode, setMode]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeContextType {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider');
  return ctx;
}
