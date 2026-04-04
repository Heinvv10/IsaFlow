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
  const { user, isAuthenticated } = useAuth();
  const [activeCompany, setActiveCompany] = useState<Company | null>(null);
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
          };
          setActiveCompany(company);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: company.id, name: company.name }));
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

    try {
      const res = await apiFetch('/api/accounting/companies?action=user-companies');

      if (!res.ok) {
        setLoading(false);
        return;
      }

      const data = await res.json();
      const raw = data.data?.items ?? data.data ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: CompanyUser[] = (Array.isArray(raw) ? raw : []).map((c: any) => ({
        companyId: (c.companyId || c.company_id) as string,
        companyName: (c.companyName || c.company_name) as string,
        role: c.role as string,
        isDefault: Boolean(c.isDefault ?? c.is_default ?? false),
      }));

      setCompanies(list);

      if (list.length === 0) {
        // User has no companies — clear any stale localStorage
        localStorage.removeItem(STORAGE_KEY);
        setActiveCompany(null);
        setLoading(false);
        return;
      }

      // Determine which company to activate
      let targetId: string | null = null;

      // 1. Check localStorage
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const { id } = JSON.parse(stored);
          if (id && list.some((c: CompanyUser) => c.companyId === id)) {
            targetId = id;
          }
        }
      } catch (e) {
        log.warn('Failed to parse stored company data', { error: e }, 'context');
      }

      // 2. Fall back to default company
      if (!targetId) {
        const defaultCompany = list.find((c: CompanyUser) => c.isDefault) ?? list[0];
        targetId = defaultCompany?.companyId ?? null;
      }

      if (!targetId) {
        setLoading(false);
        return;
      }

      // Set the role
      const match = list.find((c: CompanyUser) => c.companyId === targetId);
      if (match) setCompanyRole(match.role);

      await loadCompanyDetails(targetId);
    } catch (e) {
      log.warn('Failed to load user companies', { error: e }, 'context');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, loadCompanyDetails]);

  useEffect(() => {
    loadUserCompanies();
  }, [loadUserCompanies]);

  const switchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    const match = companies.find(c => c.companyId === companyId);
    if (match) setCompanyRole(match.role);
    await loadCompanyDetails(companyId);
    setLoading(false);

    // Set as default on the server
    try {
      await apiFetch('/api/accounting/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-default', companyId }),
      });
    } catch (e) {
      log.warn('Failed to persist default company switch', { error: e }, 'context');
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
