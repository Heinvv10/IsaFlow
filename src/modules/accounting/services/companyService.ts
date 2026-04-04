/**
 * Multi-Entity / Multi-Company Service
 * Manage companies and user-company associations.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';

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
  logoData: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankAccountType: string;
  financialYearStart: number;
  vatPeriod: string;
  vatPeriodAlignment: 'odd' | 'even';
  defaultCurrency: string;
  isActive: boolean;
  createdAt: string;
  // Lockdown
  lockdownEnabled: boolean;
  lockdownDate: string | null;
  // VAT system
  vatSystemType: string;
  // Entity & statutory
  entityType: string;
  registeredName: string | null;
  taxOffice: string | null;
  contactName: string | null;
  fax: string | null;
  mobile: string | null;
  // Physical address
  physicalAddressLine1: string | null;
  physicalAddressLine2: string | null;
  physicalCity: string | null;
  physicalProvince: string | null;
  physicalPostalCode: string | null;
  // Tax practitioner
  taxPractitionerRegNumber: string | null;
  taxPractitionerName: string | null;
  // SARS contact
  sarsContactFirstName: string | null;
  sarsContactLastName: string | null;
  sarsContactCapacity: string | null;
  sarsContactNumber: string | null;
  sarsContactTelephone: string | null;
  // Branding
  logoPosition: string;
  logoOnEmails: boolean;
  logoOnPortal: boolean;
  // Regional
  roundingType: string;
  roundToNearest: number;
  qtyDecimalPlaces: number;
  valueDecimalPlaces: number;
  hoursDecimalPlaces: number;
  costPriceDecimalPlaces: number;
  sellingPriceDecimalPlaces: number;
  currencySymbol: string;
  dateFormat: string;
  // Email toggles
  emailUseForCommunication: boolean;
  emailAlwaysCc: boolean;
  emailUseServiceFrom: boolean;
  // Customer & Supplier settings
  warnDuplicateCustomerRef: boolean;
  warnDuplicateSupplierInv: boolean;
  displayInactiveCustomersProcessing: boolean;
  displayInactiveSuppliersProcessing: boolean;
  displayInactiveCustomersReports: boolean;
  displayInactiveSuppliersReports: boolean;
  useInclusiveProcessing: boolean;
  useAccountDefaultLineType: boolean;
  // Item settings
  warnItemQtyBelowZero: boolean;
  blockItemQtyBelowZero: boolean;
  warnItemCostZero: boolean;
  warnItemSellingBelowCost: boolean;
  displayInactiveItemsProcessing: boolean;
  displayInactiveItemsReports: boolean;
  salesOrdersReserveQty: boolean;
  displayInactiveBundles: boolean;
  // Ageing
  ageingMonthly: boolean;
  ageingBasedOn: string;
  // Org classification
  industry: string | null;
  businessStructure: string | null;
  // Social media
  socialFacebook: string | null;
  socialLinkedin: string | null;
  socialX: string | null;
}

export interface CompanyUser {
  companyId: string;
  companyName: string;
  role: string;
  isDefault: boolean;
}

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

  // Auto-assign creator as owner
  await sql`
    INSERT INTO company_users (company_id, user_id, role, is_default)
    VALUES (${rows[0]!.id}::UUID, ${userId}, 'owner', false)
  `;

  log.info('Company created', { id: rows[0]!.id, name: input.name }, 'accounting');
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
      industry = COALESCE(${v('industry') ?? null}, industry),
      business_structure = COALESCE(${v('businessStructure') ?? null}, business_structure),
      social_facebook = COALESCE(${v('socialFacebook') ?? null}, social_facebook),
      social_linkedin = COALESCE(${v('socialLinkedin') ?? null}, social_linkedin),
      social_x = COALESCE(${v('socialX') ?? null}, social_x),
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

function mapCompany(r: Record<string, unknown>): Company {
  const str = (v: unknown): string => (v != null ? String(v) : '');
  const strN = (v: unknown): string | null => (v != null ? String(v) : null);
  const bool = (v: unknown, def: boolean): boolean => (v != null ? Boolean(v) : def);
  const num = (v: unknown, def: number): number => (v != null ? Number(v) : def);
  return {
    id: str(r.id),
    name: str(r.name),
    tradingName: strN(r.trading_name),
    registrationNumber: strN(r.registration_number),
    vatNumber: strN(r.vat_number),
    taxNumber: strN(r.tax_number),
    addressLine1: strN(r.address_line1),
    addressLine2: strN(r.address_line2),
    city: strN(r.city),
    province: strN(r.province),
    postalCode: strN(r.postal_code),
    country: str(r.country),
    phone: strN(r.phone),
    email: strN(r.email),
    website: strN(r.website),
    logoUrl: strN(r.logo_url),
    logoData: strN(r.logo_data),
    bankName: strN(r.bank_name),
    bankAccountNumber: strN(r.bank_account_number),
    bankBranchCode: strN(r.bank_branch_code),
    bankAccountType: str(r.bank_account_type),
    financialYearStart: num(r.financial_year_start, 3),
    vatPeriod: str(r.vat_period),
    vatPeriodAlignment: (r.vat_period_alignment != null ? String(r.vat_period_alignment) : 'odd') as 'odd' | 'even',
    defaultCurrency: str(r.default_currency),
    isActive: bool(r.is_active, true),
    createdAt: str(r.created_at),
    // Lockdown
    lockdownEnabled: bool(r.lockdown_enabled, false),
    lockdownDate: r.lockdown_date != null ? new Date(r.lockdown_date as string | number | Date).toISOString().split('T')[0]! : null,
    // VAT system
    vatSystemType: r.vat_system_type != null ? String(r.vat_system_type) : 'invoice',
    // Entity & statutory
    entityType: r.entity_type != null ? String(r.entity_type) : 'company',
    registeredName: strN(r.registered_name),
    taxOffice: strN(r.tax_office),
    contactName: strN(r.contact_name),
    fax: strN(r.fax),
    mobile: strN(r.mobile),
    // Physical address
    physicalAddressLine1: strN(r.physical_address_line1),
    physicalAddressLine2: strN(r.physical_address_line2),
    physicalCity: strN(r.physical_city),
    physicalProvince: strN(r.physical_province),
    physicalPostalCode: strN(r.physical_postal_code),
    // Tax practitioner
    taxPractitionerRegNumber: strN(r.tax_practitioner_reg_number),
    taxPractitionerName: strN(r.tax_practitioner_name),
    // SARS contact
    sarsContactFirstName: strN(r.sars_contact_first_name),
    sarsContactLastName: strN(r.sars_contact_last_name),
    sarsContactCapacity: strN(r.sars_contact_capacity),
    sarsContactNumber: strN(r.sars_contact_number),
    sarsContactTelephone: strN(r.sars_contact_telephone),
    // Branding
    logoPosition: r.logo_position != null ? String(r.logo_position) : 'top-left',
    logoOnEmails: bool(r.logo_on_emails, true),
    logoOnPortal: bool(r.logo_on_portal, true),
    // Regional
    roundingType: r.rounding_type != null ? String(r.rounding_type) : 'none',
    roundToNearest: parseFloat(r.round_to_nearest != null ? String(r.round_to_nearest) : '0'),
    qtyDecimalPlaces: num(r.qty_decimal_places, 2),
    valueDecimalPlaces: num(r.value_decimal_places, 2),
    hoursDecimalPlaces: num(r.hours_decimal_places, 2),
    costPriceDecimalPlaces: num(r.cost_price_decimal_places, 2),
    sellingPriceDecimalPlaces: num(r.selling_price_decimal_places, 2),
    currencySymbol: r.currency_symbol != null ? String(r.currency_symbol) : 'R',
    dateFormat: r.date_format != null ? String(r.date_format) : 'dd/mm/yyyy',
    // Email toggles
    emailUseForCommunication: bool(r.email_use_for_communication, true),
    emailAlwaysCc: bool(r.email_always_cc, false),
    emailUseServiceFrom: bool(r.email_use_service_from, false),
    // Customer & Supplier
    warnDuplicateCustomerRef: bool(r.warn_duplicate_customer_ref, true),
    warnDuplicateSupplierInv: bool(r.warn_duplicate_supplier_inv, true),
    displayInactiveCustomersProcessing: bool(r.display_inactive_customers_processing, false),
    displayInactiveSuppliersProcessing: bool(r.display_inactive_suppliers_processing, false),
    displayInactiveCustomersReports: bool(r.display_inactive_customers_reports, false),
    displayInactiveSuppliersReports: bool(r.display_inactive_suppliers_reports, false),
    useInclusiveProcessing: bool(r.use_inclusive_processing, true),
    useAccountDefaultLineType: bool(r.use_account_default_line_type, false),
    // Items
    warnItemQtyBelowZero: bool(r.warn_item_qty_below_zero, true),
    blockItemQtyBelowZero: bool(r.block_item_qty_below_zero, false),
    warnItemCostZero: bool(r.warn_item_cost_zero, false),
    warnItemSellingBelowCost: bool(r.warn_item_selling_below_cost, false),
    displayInactiveItemsProcessing: bool(r.display_inactive_items_processing, false),
    displayInactiveItemsReports: bool(r.display_inactive_items_reports, false),
    salesOrdersReserveQty: bool(r.sales_orders_reserve_qty, false),
    displayInactiveBundles: bool(r.display_inactive_bundles, false),
    // Ageing
    ageingMonthly: bool(r.ageing_monthly, true),
    ageingBasedOn: r.ageing_based_on != null ? String(r.ageing_based_on) : 'invoice_date',
    // Org classification
    industry: strN(r.industry),
    businessStructure: strN(r.business_structure),
    // Social media
    socialFacebook: strN(r.social_facebook),
    socialLinkedin: strN(r.social_linkedin),
    socialX: strN(r.social_x),
  };
}

// ── Document Numbers ──────────────────────────────────────────────────────────

export interface DocumentNumber {
  id: string;
  companyId: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

const DEFAULT_DOC_NUMBERS: { type: string; prefix: string }[] = [
  { type: 'quotation', prefix: 'QUO' },
  { type: 'sales_order', prefix: 'SO' },
  { type: 'customer_invoice', prefix: 'INV' },
  { type: 'credit_note', prefix: 'CRN' },
  { type: 'customer_receipt', prefix: 'RCP' },
  { type: 'customer_write_off', prefix: 'WRI' },
  { type: 'recurring_invoice', prefix: 'RINV' },
  { type: 'customer_adjustment', prefix: 'CADJ' },
  { type: 'purchase_order', prefix: 'PO' },
  { type: 'supplier_invoice', prefix: 'SIV' },
  { type: 'supplier_return', prefix: 'RTN' },
  { type: 'supplier_payment', prefix: 'PAY' },
  { type: 'supplier_adjustment', prefix: 'SADJ' },
  { type: 'delivery_note', prefix: 'DN' },
];

export async function getDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  const rows = (await sql`
    SELECT * FROM company_document_numbers WHERE company_id = ${companyId}::UUID ORDER BY document_type
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), companyId: String(r.company_id), documentType: String(r.document_type),
    prefix: String(r.prefix), nextNumber: Number(r.next_number), padding: Number(r.padding),
  }));
}

export async function ensureDocumentNumbers(companyId: string): Promise<DocumentNumber[]> {
  for (const d of DEFAULT_DOC_NUMBERS) {
    await sql`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number, padding)
      VALUES (${companyId}::UUID, ${d.type}, ${d.prefix}, 1, 7)
      ON CONFLICT (company_id, document_type) DO NOTHING
    `;
  }
  return getDocumentNumbers(companyId);
}

export async function updateDocumentNumber(companyId: string, documentType: string, prefix: string, nextNumber?: number): Promise<void> {
  if (nextNumber !== undefined) {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}, next_number = ${nextNumber}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  } else {
    await sql`
      UPDATE company_document_numbers SET prefix = ${prefix}
      WHERE company_id = ${companyId}::UUID AND document_type = ${documentType}
    `;
  }
}

// ── Company Messages ──────────────────────────────────────────────────────────

export interface CompanyMessage {
  messageType: string;
  message: string;
}

export async function getCompanyMessages(companyId: string): Promise<CompanyMessage[]> {
  const rows = (await sql`
    SELECT message_type, message FROM company_messages WHERE company_id = ${companyId}::UUID ORDER BY message_type
  `) as Record<string, unknown>[];
  return rows.map((r: Record<string, unknown>) => ({ messageType: String(r.message_type ?? ''), message: String(r.message ?? '') }));
}

export async function upsertCompanyMessage(companyId: string, messageType: string, message: string): Promise<void> {
  await sql`
    INSERT INTO company_messages (company_id, message_type, message)
    VALUES (${companyId}::UUID, ${messageType}, ${message})
    ON CONFLICT (company_id, message_type) DO UPDATE SET message = ${message}, updated_at = NOW()
  `;
}

export async function upsertCompanyMessages(companyId: string, messages: CompanyMessage[]): Promise<void> {
  for (const m of messages) {
    await upsertCompanyMessage(companyId, m.messageType, m.message);
  }
}
