import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  ReactNode,
  useCallback,
} from 'react';
import type { AuthRole } from '@/lib/auth/types';
import { clearTenantClientState } from '@/lib/auth/clearTenantClientState';
import { log } from '@/lib/logger';
import { apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { useSessionCheck } from './useSessionCheck';

/**
 * Authenticated user shape returned from /api/auth/me
 */
export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: AuthRole;
  permissions: string[];
  isActive: boolean;
  profilePicture?: string | null;
  department?: string;
  onboardingCompleted?: boolean;
}

interface AuthContextType {
  /** Currently authenticated user, or null if not logged in */
  user: AuthUser | null;
  /** True while the initial session check is in progress */
  loading: boolean;
  /** D9: the last /api/auth/me check hit an outage (5xx/408/429/unreachable), not a sign-out */
  authUnavailable: boolean;
  /** D9: a /api/auth/me check is in flight (Retry shows "Checking…") */
  authChecking: boolean;
  /** Last authentication error message */
  error: string | null;
  /** True when a valid user session exists */
  isAuthenticated: boolean;

  /** Sign in with email and password. */
  login: (email: string, password: string, deviceFingerprint?: string) => Promise<boolean>;
  /** Sign out and redirect to /sign-in */
  logout: () => Promise<void>;
  /** Re-fetch the current user from /api/auth/me */
  refreshUser: () => Promise<void>;
  /** Clear the current error state */
  clearError: () => void;

  /** Check if the user has a specific permission string */
  hasPermission: (permission: string) => boolean;
  /** Check if the user has the given role or higher */
  hasRole: (role: AuthRole) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Map the raw API response into a typed AuthUser
 */
function mapApiUser(raw: Record<string, unknown>): AuthUser {
  const firstName = (raw.firstName as string) || (raw.first_name as string) || '';
  const lastName = (raw.lastName as string) || (raw.last_name as string) || '';
  const name =
    (raw.name as string) ||
    (firstName && lastName ? `${firstName} ${lastName}`.trim() : (raw.email as string));

  return {
    id: raw.id as string,
    email: raw.email as string,
    firstName,
    lastName,
    name,
    role: (raw.role as AuthRole) || 'viewer',
    permissions: (raw.permissions as string[]) || [],
    isActive: raw.isActive !== false && raw.is_active !== false,
    profilePicture: (raw.profilePicture as string) || (raw.profile_picture as string) || null,
    department: (raw.department as string) || undefined,
    onboardingCompleted: raw.onboardingCompleted === true || raw.onboarding_completed === true,
  };
}

// Role hierarchy for permission checks. Mirrors src/lib/auth/types.ts.
const ROLE_HIERARCHY: Record<AuthRole, number> = {
  super_admin: 7,
  owner: 6,
  system: 5,
  admin: 4,
  manager: 3,
  storeman: 2,
  technician: 2,
  viewer: 1,
};

interface AuthProviderProps {
  children: ReactNode;
  /**
   * Skip the /api/auth/me fetch (and the focus/interval re-checks) and leave
   * the context in its unauthenticated/empty state. For a PDF print render
   * (see printRenderQuery.ts): under a transport that cannot stub network
   * calls (Gotenberg), a print token fed to /api/auth/me fails JWT
   * verification and its handler (withUserAuth) clears the sb-access-token
   * cookie — the SAME cookie carrying the print token — poisoning every
   * later request in the render. The print page needs no auth context, so
   * this call should not happen at all during a print render.
   */
  skipFetch?: boolean;
}

export function AuthProvider({ children, skipFetch = false }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const applyUser = useCallback((raw: Record<string, unknown> | null) => setUser(raw ? mapApiUser(raw) : null), []);
  const { checkAuth, authUnavailable, authChecking, startRetries } = useSessionCheck(applyUser, setLoading);

  useEffect(() => {
    if (skipFetch) {
      setLoading(false);
      return;
    }
    const stopRetries = startRetries();

    void checkAuth();

    // Re-fetch user when tab regains focus (picks up RBAC changes)
    const onFocus = () => checkAuth();
    window.addEventListener('focus', onFocus);

    // Also poll every 5 minutes as a fallback
    const interval = setInterval(checkAuth, 5 * 60 * 1000);

    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      stopRetries();
    };
  }, [checkAuth, skipFetch, startRetries]);

  /**
   * Sign in with email/password credentials.
   * Returns true if a 2FA challenge was issued by GoTrue, false if login completed.
   */
  const login = async (email: string, password: string, deviceFingerprint?: string): Promise<boolean> => {
    setLoading(true);
    setError(null);

    // Clear stale tenant state from any previous session so the new user
    // doesn't inherit another user's company context.
    clearTenantClientState();

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, deviceFingerprint }),
        credentials: 'include',
      });

      // A 503 is an auth outage, not a wrong password: say so unless the server gave its own sentence
      await assertOk(res, res.status === 503
        ? 'Sign-in is temporarily unavailable - please try again shortly'
        : 'Could not sign in - try again');
      const data = await res.json();

      // 2FA required — signal caller to show TOTP step
      if (data.data?.requiresTwoFactor || data.data?.requires_2fa) {
        return true;
      }

      const raw = data.data?.user ?? data.data ?? data.user;
      setUser(raw ? mapApiUser(raw) : null);
      return false;
    } catch (err) {
      const message = apiErrorMessage(err, 'Could not sign in - try again');
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign out and clear session cookie
   */
  const logout = async () => {
    try {
      // Mirror apiFetch's double-submit CSRF header so this survives /api/auth/logout
      // being wrapped with withCsrf (pentest M8). The isaflow_csrf cookie is
      // readable from JS by design; logout itself is best-effort (finally clears
      // local state + redirects regardless), but the server-side cookie clear must
      // not silently 403.
      const headers: Record<string, string> = {};
      const csrfMatch = typeof document !== 'undefined'
        ? document.cookie.split('; ').find((c) => c.startsWith('isaflow_csrf='))
        : undefined;
      if (csrfMatch) headers['X-CSRF-Token'] = csrfMatch.slice('isaflow_csrf='.length);
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers,
      });
      if (!res.ok) log.warn('Logout: the server did not clear the session cookie', { status: res.status }, 'AuthContext');
    } finally {
      setUser(null);
      clearTenantClientState();
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
  };

  const refreshUser = async () => {
    await checkAuth();
  };

  const clearError = () => {
    setError(null);
  };

  /**
   * Check if the current user holds a specific permission string.
   * Users with the 'all' permission pass all checks.
   */
  const hasPermission = (permission: string): boolean => {
    if (!user) return false;
    return user.permissions.includes('all') || user.permissions.includes(permission);
  };

  /**
   * Check if the current user's role meets or exceeds the required role level.
   */
  const hasRole = (role: AuthRole): boolean => {
    if (!user) return false;
    const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[role] ?? 0;
    return userLevel >= requiredLevel;
  };

  const value: AuthContextType = useMemo(() => ({
    user,
    loading,
    authUnavailable,
    authChecking,
    error,
    isAuthenticated: user !== null,
    login,
    logout,
    refreshUser,
    clearError,
    hasPermission,
    hasRole,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [user, loading, authUnavailable, authChecking, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
