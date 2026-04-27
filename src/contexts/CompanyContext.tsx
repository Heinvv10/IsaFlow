import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const STORAGE_KEY = 'isaflow_active_company';

export interface Company {
  id: string;
  name: string;
  tradingName?: string;
  registrationNumber?: string;
  vatNumber?: string;
  taxNumber?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  logoData?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankBranchCode?: string;
  bankAccountType?: string;
  financialYearStart?: number;
  vatPeriod?: string;
  defaultCurrency?: string;
  isActive?: boolean;
  // PRD-10 Layer 1: idle-timeout policy in minutes (default 480 = 8h).
  idleTimeoutMinutes?: number;
  // Demo tenant flag — persisted into localStorage so DemoBanner renders on first paint.
  isDemo?: boolean;
}

export interface CompanyUser {
  companyId: string;
  companyName: string;
  role: string;
  isDefault: boolean;
}

interface CompanyContextType {
  activeCompany: Company | null;
  companies: CompanyUser[];
  loading: boolean;
  companyRole: string | null;
  switchCompany: (companyId: string) => Promise<void>;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const userRole = user?.role ?? null;
  // Hydrate active company synchronously from localStorage so the first render
  // has at least {id, name} — avoids a flash of the 'ISAFlow' fallback title
  // until the async /api/accounting/companies fetch resolves. The async fetch
  // that follows will enrich the company with the full profile.
  const [activeCompany, setActiveCompany] = useState<Company | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as { id?: string; name?: string; isDemo?: boolean };
      if (parsed?.id && parsed?.name) {
        return { id: parsed.id, name: parsed.name, isDemo: parsed.isDemo ?? false };
      }
    } catch {
      // Malformed entry — fall through to null and let the fetch drive state.
    }
    return null;
  });
  const [companies, setCompanies] = useState<CompanyUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyRole, setCompanyRole] = useState<string | null>(null);

  const loadCompanyDetails = useCallback(async (companyId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
      if (res.ok) {
        const data = await res.json();
        const c = data.data;
        if (c) {
          const company: Company = {
            id: c.id,
            name: c.name,
            tradingName: c.trading_name || c.tradingName,
            registrationNumber: c.registration_number || c.registrationNumber,
            vatNumber: c.vat_number || c.vatNumber,
            taxNumber: c.tax_number || c.taxNumber,
            addressLine1: c.address_line1 || c.addressLine1,
            addressLine2: c.address_line2 || c.addressLine2,
            city: c.city,
            province: c.province,
            postalCode: c.postal_code || c.postalCode,
            country: c.country,
            phone: c.phone,
            email: c.email,
            website: c.website,
            logoUrl: c.logo_url || c.logoUrl,
            logoData: c.logo_data || c.logoData,
            bankName: c.bank_name || c.bankName,
            bankAccountNumber: c.bank_account_number || c.bankAccountNumber,
            bankBranchCode: c.bank_branch_code || c.bankBranchCode,
            bankAccountType: c.bank_account_type || c.bankAccountType,
            financialYearStart: c.financial_year_start || c.financialYearStart,
            vatPeriod: c.vat_period || c.vatPeriod,
            defaultCurrency: c.default_currency || c.defaultCurrency,
            isActive: c.is_active ?? c.isActive ?? true,
            idleTimeoutMinutes: c.idle_timeout_minutes ?? c.idleTimeoutMinutes,
            isDemo: c.is_demo ?? c.isDemo ?? false,
          };
          setActiveCompany(company);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            id: company.id,
            name: company.name,
            isDemo: company.isDemo ?? false,
          }));
          return company;
        }
      }
    } catch (e) {
      log.warn('Failed to load company details', { error: e }, 'context');
    }
    return null;
  }, []);

  const loadUserCompanies = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    // Always fetch the user's actual memberships so the switcher has options,
    // even for super_admins. The previous short-circuit that trusted localStorage
    // for super_admins without loading memberships left the switcher empty and
    // could pin the UI to a stale/impersonated company the user couldn't leave.
    let list: CompanyUser[] = [];
    try {
      const res = await apiFetch('/api/accounting/companies?action=user-companies');
      if (res.ok) {
        const data = await res.json();
        const raw = data.data?.items ?? data.data ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        list = (Array.isArray(raw) ? raw : []).map((c: any) => ({
          companyId: (c.companyId || c.company_id) as string,
          companyName: (c.companyName || c.company_name) as string,
          role: c.role as string,
          isDefault: Boolean(c.isDefault ?? c.is_default ?? false),
        }));
      }
    } catch (e) {
      log.warn('Failed to load user companies', { error: e }, 'context');
    }

    setCompanies(list);

    let storedId: string | null = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as { id?: string };
        if (parsed?.id) storedId = parsed.id;
      }
    } catch (e) {
      log.warn('Failed to parse stored company data', { error: e }, 'context');
    }

    // Determine which company to activate.
    // Regular users: localStorage id must be in their membership list.
    // Super admins: localStorage id is honored even if not a member (impersonation).
    let targetId: string | null = null;
    const storedIsMember = storedId !== null && list.some(c => c.companyId === storedId);

    if (storedIsMember) {
      targetId = storedId;
    } else if (userRole === 'super_admin' && storedId) {
      targetId = storedId;
    } else if (list.length > 0) {
      const defaultCompany = list.find(c => c.isDefault) ?? list[0];
      targetId = defaultCompany?.companyId ?? null;
    }

    if (!targetId) {
      localStorage.removeItem(STORAGE_KEY);
      setActiveCompany(null);
      setLoading(false);
      return;
    }

    const match = list.find(c => c.companyId === targetId);
    if (match) {
      setCompanyRole(match.role);
    } else if (userRole === 'super_admin') {
      setCompanyRole('owner');
    }

    await loadCompanyDetails(targetId);
    setLoading(false);
  }, [isAuthenticated, userRole, loadCompanyDetails]);

  useEffect(() => {
    loadUserCompanies();
  }, [loadUserCompanies]);

  const switchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    const match = companies.find(c => c.companyId === companyId);
    if (match) setCompanyRole(match.role);

    // Flip the HTTP-only active_company_id cookie — withAuth on the server reads
    // the cookie, not the X-Company-Id header. Without this every tenant sees
    // the first company's data because the cookie is frozen at login.
    const switchRes = await apiFetch('/api/auth/switch-company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId }),
    });
    if (!switchRes.ok) {
      log.warn('switch-company failed', { status: switchRes.status }, 'context');
      setLoading(false);
      return;
    }

    // Best-effort: persist as user's default company for next login.
    try {
      await apiFetch('/api/accounting/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-default', companyId }),
      });
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: companyId, name: newName, isDemo: false }));
      window.location.reload();
      return;
    }

    await loadCompanyDetails(companyId);
    setLoading(false);
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
