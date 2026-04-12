/**
 * Multi-Entity / Multi-Company Service
 * Manage companies and user-company associations.
 */

import { sql, withTransaction } from '@/lib/neon';
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
  defaultCurrency?: string;
}, userId: string): Promise<Company> {
  const rows = (await sql`
    INSERT INTO companies (
      name, registered_name, trading_name, registration_number, vat_number, tax_number,
      email, phone, website,
      address_line1, address_line2, city, province, postal_code, country,
      logo_data,
      bank_name, bank_account_number, bank_branch_code, bank_account_type,
      financial_year_start, vat_period, vat_period_alignment, default_currency
    ) VALUES (
      ${input.name}, ${input.name}, ${input.tradingName || null}, ${input.registrationNumber || null},
      ${input.vatNumber || null}, ${input.taxNumber || null}, ${input.email || null}, ${input.phone || null},
      ${input.website || null},
      ${input.addressLine1 || null}, ${input.addressLine2 || null}, ${input.city || null},
      ${input.province || null}, ${input.postalCode || null}, ${input.country || 'South Africa'},
      ${input.logoData || null},
      ${input.bankName || null}, ${input.bankAccountNumber || null}, ${input.bankBranchCode || null},
      ${input.bankAccountType || 'current'},
      ${input.financialYearStart ?? 3}, ${input.vatPeriod || 'bi-monthly'}, ${input.vatPeriodAlignment || 'odd'}, ${input.defaultCurrency || 'ZAR'}
    ) RETURNING *
  `) as Record<string, unknown>[];

  // Auto-assign creator as owner. If this is the user's first company,
  // mark it as default so CompanyContext auto-selects it on next load.
  const existingCountRows = (await sql`
    SELECT COUNT(*)::int AS count FROM company_users WHERE user_id = ${userId}
  `) as Array<{ count: number }>;
  const isFirstCompany = (existingCountRows[0]?.count ?? 0) === 0;

  await sql`
    INSERT INTO company_users (company_id, user_id, role, is_default)
    VALUES (${rows[0]!.id}::UUID, ${userId}, 'owner', ${isFirstCompany})
  `;

  log.info('Company created', { id: rows[0]!.id, name: input.name, isFirstCompany }, 'accounting');
  return mapCompany(rows[0]!);
}

export async function updateCompany(id: string, input: Partial<Record<string, unknown>>): Promise<Company> {
  const v = (key: string) => input[key] !== undefined ? (input[key] === '' ? null : input[key]) : undefined;

  const rows = (await sql`
    UPDATE companies SET
      name = COALESCE(${v('name') ?? null}, name),
      trading_name = COALESCE(${v('tradingName') ?? null}, trading_name),
      registration_number = COALESCE(${v('registrationNumber') ?? null}, registration_number),
      vat_number = COALESCE(${v('vatNumber') ?? null}, vat_number),
      tax_number = COALESCE(${v('taxNumber') ?? null}, tax_number),
      address_line1 = COALESCE(${v('addressLine1') ?? null}, address_line1),
      address_line2 = COALESCE(${v('addressLine2') ?? null}, address_line2),
      city = COALESCE(${v('city') ?? null}, city),
      province = COALESCE(${v('province') ?? null}, province),
      postal_code = COALESCE(${v('postalCode') ?? null}, postal_code),
      country = COALESCE(${v('country') ?? null}, country),
      phone = COALESCE(${v('phone') ?? null}, phone),
      email = COALESCE(${v('email') ?? null}, email),
      website = COALESCE(${v('website') ?? null}, website),
      logo_data = COALESCE(${v('logoData') ?? null}, logo_data),
      bank_name = COALESCE(${v('bankName') ?? null}, bank_name),
      bank_account_number = COALESCE(${v('bankAccountNumber') ?? null}, bank_account_number),
      bank_branch_code = COALESCE(${v('bankBranchCode') ?? null}, bank_branch_code),
      bank_account_type = COALESCE(${v('bankAccountType') ?? null}, bank_account_type),
      financial_year_start = COALESCE(${v('financialYearStart') ?? null}, financial_year_start),
      vat_period = COALESCE(${v('vatPeriod') ?? null}, vat_period),
      vat_period_alignment = COALESCE(${v('vatPeriodAlignment') ?? null}, vat_period_alignment),
      default_currency = COALESCE(${v('defaultCurrency') ?? null}, default_currency),
      lockdown_enabled = COALESCE(${v('lockdownEnabled') ?? null}, lockdown_enabled),
      lockdown_date = COALESCE(${v('lockdownDate') ?? null}::date, lockdown_date),
      vat_system_type = COALESCE(${v('vatSystemType') ?? null}, vat_system_type),
      entity_type = COALESCE(${v('entityType') ?? null}, entity_type),
      registered_name = COALESCE(${v('registeredName') ?? null}, registered_name),
      tax_office = COALESCE(${v('taxOffice') ?? null}, tax_office),
      contact_name = COALESCE(${v('contactName') ?? null}, contact_name),
      fax = COALESCE(${v('fax') ?? null}, fax),
      mobile = COALESCE(${v('mobile') ?? null}, mobile),
      physical_address_line1 = COALESCE(${v('physicalAddressLine1') ?? null}, physical_address_line1),
      physical_address_line2 = COALESCE(${v('physicalAddressLine2') ?? null}, physical_address_line2),
      physical_city = COALESCE(${v('physicalCity') ?? null}, physical_city),
      physical_province = COALESCE(${v('physicalProvince') ?? null}, physical_province),
      physical_postal_code = COALESCE(${v('physicalPostalCode') ?? null}, physical_postal_code),
      tax_practitioner_reg_number = COALESCE(${v('taxPractitionerRegNumber') ?? null}, tax_practitioner_reg_number),
      tax_practitioner_name = COALESCE(${v('taxPractitionerName') ?? null}, tax_practitioner_name),
      sars_contact_first_name = COALESCE(${v('sarsContactFirstName') ?? null}, sars_contact_first_name),
      sars_contact_last_name = COALESCE(${v('sarsContactLastName') ?? null}, sars_contact_last_name),
      sars_contact_capacity = COALESCE(${v('sarsContactCapacity') ?? null}, sars_contact_capacity),
      sars_contact_number = COALESCE(${v('sarsContactNumber') ?? null}, sars_contact_number),
      sars_contact_telephone = COALESCE(${v('sarsContactTelephone') ?? null}, sars_contact_telephone),
      logo_position = COALESCE(${v('logoPosition') ?? null}, logo_position),
      logo_on_emails = COALESCE(${v('logoOnEmails') ?? null}, logo_on_emails),
      logo_on_portal = COALESCE(${v('logoOnPortal') ?? null}, logo_on_portal),
      rounding_type = COALESCE(${v('roundingType') ?? null}, rounding_type),
      round_to_nearest = COALESCE(${v('roundToNearest') ?? null}, round_to_nearest),
      qty_decimal_places = COALESCE(${v('qtyDecimalPlaces') ?? null}, qty_decimal_places),
      value_decimal_places = COALESCE(${v('valueDecimalPlaces') ?? null}, value_decimal_places),
      hours_decimal_places = COALESCE(${v('hoursDecimalPlaces') ?? null}, hours_decimal_places),
      cost_price_decimal_places = COALESCE(${v('costPriceDecimalPlaces') ?? null}, cost_price_decimal_places),
      selling_price_decimal_places = COALESCE(${v('sellingPriceDecimalPlaces') ?? null}, selling_price_decimal_places),
      currency_symbol = COALESCE(${v('currencySymbol') ?? null}, currency_symbol),
      date_format = COALESCE(${v('dateFormat') ?? null}, date_format),
      email_use_for_communication = COALESCE(${v('emailUseForCommunication') ?? null}, email_use_for_communication),
      email_always_cc = COALESCE(${v('emailAlwaysCc') ?? null}, email_always_cc),
      email_use_service_from = COALESCE(${v('emailUseServiceFrom') ?? null}, email_use_service_from),
      warn_duplicate_customer_ref = COALESCE(${v('warnDuplicateCustomerRef') ?? null}, warn_duplicate_customer_ref),
      warn_duplicate_supplier_inv = COALESCE(${v('warnDuplicateSupplierInv') ?? null}, warn_duplicate_supplier_inv),
      display_inactive_customers_processing = COALESCE(${v('displayInactiveCustomersProcessing') ?? null}, display_inactive_customers_processing),
      display_inactive_suppliers_processing = COALESCE(${v('displayInactiveSuppliersProcessing') ?? null}, display_inactive_suppliers_processing),
      display_inactive_customers_reports = COALESCE(${v('displayInactiveCustomersReports') ?? null}, display_inactive_customers_reports),
      display_inactive_suppliers_reports = COALESCE(${v('displayInactiveSuppliersReports') ?? null}, display_inactive_suppliers_reports),
      use_inclusive_processing = COALESCE(${v('useInclusiveProcessing') ?? null}, use_inclusive_processing),
      use_account_default_line_type = COALESCE(${v('useAccountDefaultLineType') ?? null}, use_account_default_line_type),
      warn_item_qty_below_zero = COALESCE(${v('warnItemQtyBelowZero') ?? null}, warn_item_qty_below_zero),
      block_item_qty_below_zero = COALESCE(${v('blockItemQtyBelowZero') ?? null}, block_item_qty_below_zero),
      warn_item_cost_zero = COALESCE(${v('warnItemCostZero') ?? null}, warn_item_cost_zero),
      warn_item_selling_below_cost = COALESCE(${v('warnItemSellingBelowCost') ?? null}, warn_item_selling_below_cost),
      display_inactive_items_processing = COALESCE(${v('displayInactiveItemsProcessing') ?? null}, display_inactive_items_processing),
      display_inactive_items_reports = COALESCE(${v('displayInactiveItemsReports') ?? null}, display_inactive_items_reports),
      sales_orders_reserve_qty = COALESCE(${v('salesOrdersReserveQty') ?? null}, sales_orders_reserve_qty),
      display_inactive_bundles = COALESCE(${v('displayInactiveBundles') ?? null}, display_inactive_bundles),
      ageing_monthly = COALESCE(${v('ageingMonthly') ?? null}, ageing_monthly),
      ageing_based_on = COALESCE(${v('ageingBasedOn') ?? null}, ageing_based_on),
      aging_basis = COALESCE(${v('agingBasis') ?? null}, aging_basis),
      aging_period_type = COALESCE(${v('agingPeriodType') ?? null}, aging_period_type),
      aging_bucket1_days = COALESCE(${v('agingBucket1Days') ?? null}::int, aging_bucket1_days),
      aging_bucket2_days = COALESCE(${v('agingBucket2Days') ?? null}::int, aging_bucket2_days),
      aging_bucket3_days = COALESCE(${v('agingBucket3Days') ?? null}::int, aging_bucket3_days),
      invoice_email_subject = COALESCE(${v('invoiceEmailSubject') ?? null}, invoice_email_subject),
      invoice_email_body = COALESCE(${v('invoiceEmailBody') ?? null}, invoice_email_body),
      quote_email_subject = COALESCE(${v('quoteEmailSubject') ?? null}, quote_email_subject),
      quote_email_body = COALESCE(${v('quoteEmailBody') ?? null}, quote_email_body),
      statement_email_subject = COALESCE(${v('statementEmailSubject') ?? null}, statement_email_subject),
      statement_email_body = COALESCE(${v('statementEmailBody') ?? null}, statement_email_body),
      decimal_separator = COALESCE(${v('decimalSeparator') ?? null}, decimal_separator),
      thousands_separator = COALESCE(${v('thousandsSeparator') ?? null}, thousands_separator),
      decimal_places = COALESCE(${v('decimalPlaces') ?? null}::int, decimal_places),
      industry = COALESCE(${v('industry') ?? null}, industry),
      business_structure = COALESCE(${v('businessStructure') ?? null}, business_structure),
      social_facebook = COALESCE(${v('socialFacebook') ?? null}, social_facebook),
      social_linkedin = COALESCE(${v('socialLinkedin') ?? null}, social_linkedin),
      social_x = COALESCE(${v('socialX') ?? null}, social_x),
      invoice_logo_position = COALESCE(${v('invoiceLogoPosition') ?? null}, invoice_logo_position),
      rounding_method = COALESCE(${v('roundingMethod') ?? null}, rounding_method),
      updated_at = NOW()
    WHERE id = ${id}::UUID RETURNING *
  `) as Record<string, unknown>[];
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
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    companyId: String(r.company_id),
    companyName: String(r.company_name),
    role: String(r.role),
    isDefault: Boolean(r.is_default),
  }));
}

export async function setDefaultCompany(userId: string, companyId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx`UPDATE company_users SET is_default = false WHERE user_id = ${userId}`;
    await tx`UPDATE company_users SET is_default = true WHERE user_id = ${userId} AND company_id = ${companyId}::UUID`;
  });
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
  getCompanyMessages,
  upsertCompanyMessage,
  upsertCompanyMessages,
} from './companySettingsService';
