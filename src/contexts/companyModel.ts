/**
 * The company shapes CompanyProvider holds, and the two pure translations it
 * needs: an API row to a `Company`, and the localStorage stub that lets the
 * first paint show a company name instead of the 'ISAFlow' fallback.
 *
 * Split out of CompanyContext.tsx, which was over the 300-line ceiling. No
 * behaviour moves with it: every function here is what the provider already
 * did inline, and the provider's tests are unchanged.
 *
 * Why the API row is read snake_case-OR-camelCase: `/api/accounting/companies`
 * returns raw database rows on one path and mapped objects on another, and the
 * provider has always accepted both.
 */

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
  vatSystemType?: string;
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

export const COMPANY_STORAGE_KEY = 'isaflow_active_company';

/** The minimal company the first paint can be drawn from. */
export interface StoredCompany {
  id: string;
  name: string;
  isDemo: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One API row → a Company. */
export function mapCompanyRow(c: any): Company {
  return {
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
    vatSystemType: c.vat_system_type || c.vatSystemType,
    defaultCurrency: c.default_currency || c.defaultCurrency,
    isActive: c.is_active ?? c.isActive ?? true,
    idleTimeoutMinutes: c.idle_timeout_minutes ?? c.idleTimeoutMinutes,
    isDemo: c.is_demo ?? c.isDemo ?? false,
  };
}

/** The membership list from `?action=user-companies`, in either casing. */
export function mapCompanyUsers(raw: unknown): CompanyUser[] {
  return (Array.isArray(raw) ? raw : []).map((c: any) => ({
    companyId: (c.companyId || c.company_id) as string,
    companyName: (c.companyName || c.company_name) as string,
    role: c.role as string,
    isDefault: Boolean(c.isDefault ?? c.is_default ?? false),
  }));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** The stored active company, or null when there is none, storage is
 *  unavailable, or the entry is malformed. Never throws: a bad entry must fall
 *  through to the fetch, not break the first render. */
export function readStoredCompany(): StoredCompany | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(COMPANY_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { id?: string; name?: string; isDemo?: boolean };
    if (parsed?.id && parsed?.name) {
      return { id: parsed.id, name: parsed.name, isDemo: parsed.isDemo ?? false };
    }
  } catch {
    // Malformed entry — the caller falls through to the fetch.
  }
  return null;
}

/** Just the id, for the path that only needs to know which company was active.
 *  Separate from readStoredCompany because an entry with an id but no name is
 *  still a usable target for the membership check. `onParseError` keeps the
 *  provider's existing warning at its existing call site. */
export function readStoredCompanyId(onParseError?: (e: unknown) => void): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(COMPANY_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { id?: string };
    return parsed?.id ?? null;
  } catch (e) {
    onParseError?.(e);
    return null;
  }
}

/** Deliberately unguarded, matching the call sites this was lifted from: a
 *  storage failure here propagates exactly where it did before. */
export function writeStoredCompany(entry: StoredCompany): void {
  window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify(entry));
}

export function clearStoredCompany(): void {
  window.localStorage.removeItem(COMPANY_STORAGE_KEY);
}
