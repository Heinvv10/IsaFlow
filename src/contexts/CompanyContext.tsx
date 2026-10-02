import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { apiErrorMessage, apiFetch, assertOk, ApiEnvelopeError } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  mapCompanyRow, mapCompanyUsers, readStoredCompany, readStoredCompanyId,
  writeStoredCompany, clearStoredCompany, type Company, type CompanyUser,
} from './companyModel';

// The shapes and the two pure translations live in companyModel.ts (300-line
// ceiling). Re-exported so every existing import site is unchanged.
export type { Company, CompanyUser } from './companyModel';

interface CompanyContextType {
  activeCompany: Company | null;
  companies: CompanyUser[];
  loading: boolean;
  companyRole: string | null;
  switchCompany: (companyId: string) => Promise<void>;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

interface CompanyProviderProps {
  children: ReactNode;
  /**
   * Skip every fetch this provider would otherwise make and leave it in its
   * empty state (no active company, no memberships, not loading). For a PDF
   * print render (see printRenderQuery.ts): the print page needs no company
   * context, and under a transport that cannot stub network calls
   * (Gotenberg), the unauthorised `/api/accounting/companies` fetch this
   * provider makes 401s and apiFetch's global redirect (src/lib/apiFetch.ts)
   * navigates the whole render to /login before it can finish.
   */
  skipFetch?: boolean;
}

export function CompanyProvider({ children, skipFetch = false }: CompanyProviderProps) {
  const { isAuthenticated, user, loading: authLoading } = useAuth();
  const userRole = user?.role ?? null;
  const userId = user?.id ?? null;
  // Hydrate active company synchronously from localStorage so the first render
  // has at least {id, name} — avoids a flash of the 'ISAFlow' fallback title
  // until the async /api/accounting/companies fetch resolves. The async fetch
  // that follows will enrich the company with the full profile.
  const [activeCompany, setActiveCompany] = useState<Company | null>(readStoredCompany);
  const [companies, setCompanies] = useState<CompanyUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyRole, setCompanyRole] = useState<string | null>(null);

  const loadCompanyDetails = useCallback(async (companyId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
      await assertOk(res, 'Could not load the company details');
      const data = await res.json();
      const c = data.data;
      if (c) {
        const company = mapCompanyRow(c);
        setActiveCompany(company);
        writeStoredCompany({ id: company.id, name: company.name, isDemo: company.isDemo ?? false });
        return company;
      }
    } catch (e) {
      // Enrichment of the {id, name} already hydrated from storage: keep that value, say why in the log.
      log.warn('Failed to load company details', { error: e }, 'context');
    }
    return null;
  }, []);

  const loadUserCompanies = useCallback(async () => {
    try {
      if (authLoading) {
        setLoading(true);
        return;
      }

      if (!isAuthenticated) {
        setCompanies([]);
        setActiveCompany(null);
        setCompanyRole(null);
        return;
      }

      setLoading(true);

      // Always fetch the user's actual memberships so the switcher has options,
      // even for super_admins. The previous short-circuit that trusted localStorage
      // for super_admins without loading memberships left the switcher empty and
      // could pin the UI to a stale/impersonated company the user couldn't leave.
      // The same response carries the company withAuth scoped it to — the
      // active_company_id cookie every API call on the page is served from.
      let list: CompanyUser[] = [];
      let targetId: string | null = null;
      let answered = false;
      try {
        const res = await apiFetch('/api/accounting/companies?action=user-companies');
        if (res.ok) {
          const data = await res.json();
          list = mapCompanyUsers(data.data?.items ?? data.data ?? []);
          targetId = typeof data.data?.activeCompanyId === 'string' ? data.data.activeCompanyId : null;
          answered = true;
        } else {
          log.warn('Failed to load user companies', { status: res.status }, 'context');
        }
      } catch (e) {
        log.warn('Failed to load user companies', { error: e }, 'context');
      }

      setCompanies(list);

      // No answer says nothing about which company the session serves: show no
      // name, but leave localStorage alone so a transient failure cannot wipe a
      // stored (e.g. impersonated) company. A successful empty list clears below.
      if (!answered) {
        setActiveCompany(null);
        return;
      }

      // Activate the company the SERVER session serves, never the localStorage
      // copy: when the two disagree (cookie A, stored B), the stored one would
      // put B's name over A's data (R-148). localStorage is corrected to the
      // server, not the other way round — nothing here POSTs switch-company,
      // so a stale copy can never move the session. Impersonation needs no
      // branch: impersonate-exchange sets the cookie, so it arrives here.
      const storedId = readStoredCompanyId(
        (e) => log.warn('Failed to parse stored company data', { error: e }, 'context'),
      );

      if (!targetId) {
        clearStoredCompany();
        setActiveCompany(null);
        return;
      }

      if (storedId !== targetId) clearStoredCompany();
      // Drop the first-paint stub when it names another company, so a failed
      // details fetch below cannot leave it on screen.
      setActiveCompany(prev => (prev?.id === targetId ? prev : null));

      const match = list.find(c => c.companyId === targetId);
      if (match) {
        setCompanyRole(match.role);
      } else if (userRole === 'super_admin') {
        setCompanyRole('owner');
      }

      await loadCompanyDetails(targetId);
    } finally {
      if (!authLoading) setLoading(false);   // while auth resolves the spinner stays up
    }
  }, [authLoading, isAuthenticated, userRole, loadCompanyDetails]);

  useEffect(() => {
    if (skipFetch) {
      setLoading(false);
      return;
    }
    void loadUserCompanies();
  }, [loadUserCompanies, skipFetch]);

  // Cross-tenant safety: when the authenticated user identity changes inside
  // the same provider instance (a soft-nav login after logout, or any future
  // flow that doesn't hard-reload), drop the previous user's tenant state
  // immediately instead of leaving it visible until the async user-companies
  // refetch returns. The ref starts as `undefined` (sentinel) so the first
  // run after mount is a no-op even if a future change makes AuthContext
  // start with a non-null user — keeps the reset gated to genuine identity
  // transitions, not initial hydration. Login (null → user) and logout
  // (user → null) are skipped because loadUserCompanies and
  // AuthContext.logout already clean those paths.
  const lastUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = lastUserIdRef.current;
    lastUserIdRef.current = userId;
    if (prev === undefined) return;
    if (prev === null || userId === null) return;
    if (userId === prev) return;
    setActiveCompany(null);
    setCompanies([]);
    setCompanyRole(null);
    if (typeof window !== 'undefined') {
      try { clearStoredCompany(); } catch { /* best effort */ }
    }
  }, [userId]);

  const switchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    let reloading = false;
    try {
      const match = companies.find(c => c.companyId === companyId);

      // Flip the HTTP-only active_company_id cookie — withAuth on the server reads
      // the cookie, not the X-Company-Id header. Without this every tenant sees
      // the first company's data because the cookie is frozen at login.
      try {
        const switchRes = await apiFetch('/api/auth/switch-company', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId }),
        });
        await assertOk(switchRes, 'Could not switch company - try again');
      } catch (e) {
        // Still on the old company: keep its role, and tell the caller so it does not carry on as if switched
        log.warn('switch-company failed', { error: e }, 'context');
        throw new ApiEnvelopeError(apiErrorMessage(e, 'Could not switch company - try again'));   // a plain, user-facing sentence; callers show it via apiErrorMessage
      }
      if (match) setCompanyRole(match.role);

      // Best-effort: persist as user's default company for next login.
      try {
        const defaultRes = await apiFetch('/api/accounting/companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-default', companyId }),
        });
        await assertOk(defaultRes, 'Could not remember this company as your default');
      } catch (e) {
        log.warn('Failed to persist default company switch', { error: e }, 'context');
      }

      // Cookie is live — mirror it into localStorage so the post-reload hydration
      // reads the new company immediately (otherwise the header flashes the old
      // tenant's name while every API call uses the new cookie = mismatched UI).
      if (typeof window !== 'undefined') {
        const newName = match?.companyName ?? '';
        // isDemo is not known for the target company at switch time — clear it so
        // loadCompanyDetails can re-hydrate the correct value after reload.
        writeStoredCompany({ id: companyId, name: newName, isDemo: false });
        reloading = true;
        window.location.reload();
        return;
      }

      await loadCompanyDetails(companyId);
    } finally {
      if (!reloading) setLoading(false);   // a reload keeps the spinner up until the page is gone
    }
  }, [companies, loadCompanyDetails]);

  const value = useMemo<CompanyContextType>(
    () => ({ activeCompany, companies, loading, companyRole, switchCompany }),
    [activeCompany, companies, loading, companyRole, switchCompany],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (context === undefined) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
}
