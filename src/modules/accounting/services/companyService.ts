/**
 * Multi-Entity / Multi-Company Service
 * Manage companies and user-company associations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  name: string;
  tradingName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankAccountType: string;
  financialYearStart: number;
  vatPeriod: string;
  defaultCurrency: string;
  isActive: boolean;
  createdAt: string;
}

export interface CompanyUser {
  companyId: string;
  companyName: string;
  role: string;
  isDefault: boolean;
}

// ── Company CRUD ─────────────────────────────────────────────────────────────

export async function listCompanies(): Promise<Company[]> {
  const rows = (await sql`SELECT * FROM companies WHERE is_active = true ORDER BY name`) as Row[];
  return rows.map(mapCompany);
}

export async function getCompany(id: string): Promise<Company | null> {
  const rows = (await sql`SELECT * FROM companies WHERE id = ${id}::UUID`) as Row[];
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
}, userId: string): Promise<Company> {
  const rows = (await sql`
    INSERT INTO companies (name, trading_name, registration_number, vat_number, tax_number, email, phone)
    VALUES (${input.name}, ${input.tradingName || null}, ${input.registrationNumber || null},
            ${input.vatNumber || null}, ${input.taxNumber || null}, ${input.email || null}, ${input.phone || null})
    RETURNING *
  `) as Row[];

  // Auto-assign creator as owner
  await sql`
    INSERT INTO company_users (company_id, user_id, role, is_default)
    VALUES (${rows[0].id}::UUID, ${userId}, 'owner', false)
  `;

  log.info('Company created', { id: rows[0].id, name: input.name }, 'accounting');
  return mapCompany(rows[0]);
}

export async function updateCompany(id: string, input: Partial<{
  name: string;
  tradingName: string;
  registrationNumber: string;
  vatNumber: string;
  taxNumber: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  province: string;
  postalCode: string;
  phone: string;
  email: string;
  website: string;
  bankName: string;
  bankAccountNumber: string;
  bankBranchCode: string;
  financialYearStart: number;
  vatPeriod: string;
}>): Promise<Company> {
  const rows = (await sql`
    UPDATE companies SET
      name = COALESCE(${input.name ?? null}, name),
      trading_name = COALESCE(${input.tradingName ?? null}, trading_name),
      registration_number = COALESCE(${input.registrationNumber ?? null}, registration_number),
      vat_number = COALESCE(${input.vatNumber ?? null}, vat_number),
      tax_number = COALESCE(${input.taxNumber ?? null}, tax_number),
      address_line1 = COALESCE(${input.addressLine1 ?? null}, address_line1),
      address_line2 = COALESCE(${input.addressLine2 ?? null}, address_line2),
      city = COALESCE(${input.city ?? null}, city),
      province = COALESCE(${input.province ?? null}, province),
      postal_code = COALESCE(${input.postalCode ?? null}, postal_code),
      phone = COALESCE(${input.phone ?? null}, phone),
      email = COALESCE(${input.email ?? null}, email),
      website = COALESCE(${input.website ?? null}, website),
      bank_name = COALESCE(${input.bankName ?? null}, bank_name),
      bank_account_number = COALESCE(${input.bankAccountNumber ?? null}, bank_account_number),
      bank_branch_code = COALESCE(${input.bankBranchCode ?? null}, bank_branch_code),
      financial_year_start = COALESCE(${input.financialYearStart ?? null}, financial_year_start),
      vat_period = COALESCE(${input.vatPeriod ?? null}, vat_period),
      updated_at = NOW()
    WHERE id = ${id}::UUID RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Company ${id} not found`);
  return mapCompany(rows[0]);
}

// ── User-Company ─────────────────────────────────────────────────────────────

export async function getUserCompanies(userId: string): Promise<CompanyUser[]> {
  const rows = (await sql`
    SELECT cu.company_id, c.name AS company_name, cu.role, cu.is_default
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${userId} AND c.is_active = true
    ORDER BY cu.is_default DESC, c.name ASC
  `) as Row[];
  return rows.map((r: Row) => ({
    companyId: r.company_id,
    companyName: r.company_name,
    role: r.role,
    isDefault: r.is_default,
  }));
}

export async function setDefaultCompany(userId: string, companyId: string): Promise<void> {
  await sql`UPDATE company_users SET is_default = false WHERE user_id = ${userId}`;
  await sql`UPDATE company_users SET is_default = true WHERE user_id = ${userId} AND company_id = ${companyId}::UUID`;
}

export async function addUserToCompany(companyId: string, userId: string, role = 'user'): Promise<void> {
  await sql`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES (${companyId}::UUID, ${userId}, ${role})
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = ${role}
  `;
}

export async function removeUserFromCompany(companyId: string, userId: string): Promise<void> {
  await sql`DELETE FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}`;
}

// ── Mapper ───────────────────────────────────────────────────────────────────

function mapCompany(r: Row): Company {
  return {
    id: r.id,
    name: r.name,
    tradingName: r.trading_name,
    registrationNumber: r.registration_number,
    vatNumber: r.vat_number,
    taxNumber: r.tax_number,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    province: r.province,
    postalCode: r.postal_code,
    country: r.country,
    phone: r.phone,
    email: r.email,
    website: r.website,
    logoUrl: r.logo_url,
    bankName: r.bank_name,
    bankAccountNumber: r.bank_account_number,
    bankBranchCode: r.bank_branch_code,
    bankAccountType: r.bank_account_type,
    financialYearStart: r.financial_year_start,
    vatPeriod: r.vat_period,
    defaultCurrency: r.default_currency,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}
