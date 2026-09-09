/**
 * Multi-Entity / Multi-Company Service
 * Manage companies and user-company associations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mapCompany } from './companyMapper';
import type { Company, CompanyUser } from './companyMapper';

export type { Company, CompanyUser } from './companyMapper';

// ── Company CRUD ─────────────────────────────────────────────────────────────

export async function listCompanies(): Promise<Company[]> {
  const rows = (await sql`SELECT * FROM companies WHERE is_active = true ORDER BY name`) as Record<string, unknown>[];
  return rows.map(mapCompany);
}

export async function getCompany(id: string): Promise<Company | null> {
  const rows = (await sql`SELECT * FROM companies WHERE id = ${id}::UUID`) as Record<string, unknown>[];
  return rows[0] ? mapCompany(rows[0]) : null;
}

export async function createCompany(input: {
  name: string;
  tradingName?: string;
  registrationNumber?: string;
  vatNumber?: string;
  taxNumber?: string;
  email?: string;
  phone?: string;
  website?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
  logoData?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankBranchCode?: string;
  bankAccountType?: string;
  financialYearStart?: number;
  vatPeriod?: string;
  vatPeriodAlignment?: 'odd' | 'even';
  vatSystemType?: string;
  defaultCurrency?: string;
}, _userId: string): Promise<Company> {
  // Delegates to the public.create_company_with_owner SECURITY DEFINER helper
  // (mig 459). The helper runs the two INSERTs atomically while bypassing the
  // RLS policies on companies/company_users — raw INSERTs from app_user are
  // blocked by design to avoid privilege-escalation holes. The owner user is
  // taken from auth.uid() inside the function, so _userId is unused.
  const payload = JSON.stringify({
    name: input.name,
    tradingName: input.tradingName ?? null,
    registrationNumber: input.registrationNumber ?? null,
    vatNumber: input.vatNumber ?? null,
    taxNumber: input.taxNumber ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    addressLine1: input.addressLine1 ?? null,
    addressLine2: input.addressLine2 ?? null,
    city: input.city ?? null,
    province: input.province ?? null,
    postalCode: input.postalCode ?? null,
    country: input.country ?? null,
    logoData: input.logoData ?? null,
    bankName: input.bankName ?? null,
    bankAccountNumber: input.bankAccountNumber ?? null,
    bankBranchCode: input.bankBranchCode ?? null,
    bankAccountType: input.bankAccountType ?? null,
    financialYearStart: input.financialYearStart ?? null,
    vatPeriod: input.vatPeriod ?? null,
    vatPeriodAlignment: input.vatPeriodAlignment ?? null,
    // Omitted → the SQL function derives it from vatPeriod (mig 513).
    vatSystemType: input.vatSystemType ?? null,
    defaultCurrency: input.defaultCurrency ?? null,
  });

  const rows = (await sql`
    SELECT * FROM public.create_company_with_owner(${payload}::jsonb)
  `) as Record<string, unknown>[];

  const created = rows[0];
  if (!created) throw new Error('create_company_with_owner returned no row');

  log.info('Company created', { id: created.id, name: input.name }, 'accounting');
  return mapCompany(created);
}

export { updateCompany, requestLockdownChange } from './companyLockControl';

// ── User-Company ─────────────────────────────────────────────────────────────

export async function getUserCompanies(userId: string): Promise<CompanyUser[]> {
  const rows = (await sql`
    SELECT cu.company_id, c.name AS company_name, cu.role, cu.is_default
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${userId} AND c.is_active = true
    ORDER BY cu.is_default DESC, c.name ASC
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    companyId: String(r.company_id),
    companyName: String(r.company_name),
    role: String(r.role),
    isDefault: Boolean(r.is_default),
  }));
}

/**
 * Runs through auth.set_default_company (mig 516, SECURITY DEFINER): under the
 * request transaction company_users is RLS-guarded by cu_admin_write, so a
 * plain UPDATE is a silent 0-row no-op for non-admin roles.
 */
export async function setDefaultCompany(userId: string, companyId: string): Promise<void> {
  await sql`SELECT auth.set_default_company(${userId}::UUID, ${companyId}::UUID)`;
}

// ── Settings & Document Numbers (re-exported from companySettingsService) ────

export type {
  DocumentNumber,
  CompanyMessage,
} from './companySettingsService';

export {
  getDocumentNumbers,
  ensureDocumentNumbers,
  updateDocumentNumber,
  formatDocumentNumber,
  reserveNextDocumentNumber,
  peekNextDocumentNumber,
  getCompanyMessages,
  upsertCompanyMessage,
  upsertCompanyMessages,
} from './companySettingsService';
