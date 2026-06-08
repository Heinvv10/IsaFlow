/**
 * Theme mode — the practitioner/client visual axis.
 * 'practitioner' = Dense (firm staff). 'client' = Warm (business owner / portal).
 * Pure decision logic only; the React glue lives in ThemeModeContext.
 */

export type ThemeMode = 'practitioner' | 'client';

export const THEME_MODE_STORAGE_KEY = 'isaflow.themeMode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'practitioner' || value === 'client';
}

interface ResolveInput {
  /** Explicit user/localStorage choice — wins when valid. */
  override?: ThemeMode;
  /** Per-company role from CompanyContext. */
  companyRole?: string | null;
  /** Hostname, for a future direct-client subdomain. */
  host?: string | null;
}

/** Roles that indicate a business owner rather than firm staff. */
const CLIENT_ROLES = new Set(['owner', 'client']);

export function resolveThemeMode({ override, companyRole }: ResolveInput): ThemeMode {
  if (isThemeMode(override)) return override;
  if (companyRole && CLIENT_ROLES.has(companyRole)) return 'client';
  return 'practitioner';
}
