import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
  useCallback,
} from 'react';
import type { AuthRole } from '@/lib/auth/types';

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
  /** Last authentication error message */
  error: string | null;
  /** True when a valid user session exists */
  isAuthenticated: boolean;

  /** Sign in with email and password */
  login: (email: string, password: string) => Promise<void>;
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

// Role hierarchy for permission checks
const ROLE_HIERARCHY: Record<AuthRole, number> = {
  super_admin: 6,
  system: 5,
  admin: 4,
  manager: 3,
  storeman: 2,
  technician: 2,
  viewer: 1,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch current session from the API
   */
  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });

      if (res.ok) {
        const data = await res.json();
        // Support both { data: { user } } and { data: user } shapes
        const raw = data.data?.user ?? data.data ?? data.user;
        if (raw) {
          setUser(mapApiUser(raw));
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();

    // Re-fetch user when tab regains focus (picks up RBAC changes)
    const onFocus = () => checkAuth();
    window.addEventListener('focus', onFocus);

    // Also poll every 5 minutes as a fallback
    const interval = setInterval(checkAuth, 5 * 60 * 1000);

    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [checkAuth]);

  /**
   * Sign in with email/password credentials
   */
  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || data.message || 'Login failed');
      }

      const raw = data.data?.user ?? data.data ?? data.user;
      setUser(raw ? mapApiUser(raw) : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign out and clear session cookie
   */
  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      setUser(null);
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

  const value: AuthContextType = {
    user,
    loading,
    error,
    isAuthenticated: user !== null,
    login,
    logout,
    refreshUser,
    clearError,
    hasPermission,
    hasRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
