/**
 * Company type definitions and DB row mapper.
 * Extracted from companyService.ts for file-size compliance.
 */
import { fmtDate } from '@/lib/fmtDate';

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
  // Payroll tax registration (for IRP5/EMP501 — SARS BRS v25.2)
  payeReferenceNumber: string | null;
  sdlReferenceNumber: string | null;
  uifReferenceNumber: string | null;
  sic7Code: string | null;
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
  agingBasis: string;
  agingPeriodType: string;
  agingBucket1Days: number;
  agingBucket2Days: number;
  agingBucket3Days: number;
  // Email templates
  invoiceEmailSubject: string;
  invoiceEmailBody: string | null;
  invoiceEmailSignature: string | null;
  quoteEmailSubject: string;
  quoteEmailBody: string | null;
  quoteEmailSignature: string | null;
  statementEmailSubject: string;
  statementEmailBody: string | null;
  statementEmailSignature: string | null;
  creditNoteEmailSubject: string;
  creditNoteEmailBody: string | null;
  creditNoteEmailSignature: string | null;
  salesOrderEmailSubject: string;
  salesOrderEmailBody: string | null;
  salesOrderEmailSignature: string | null;
  recurringInvoiceEmailSubject: string;
  recurringInvoiceEmailBody: string | null;
  recurringInvoiceEmailSignature: string | null;
  // Regional format extras
  decimalSeparator: string;
  thousandsSeparator: string;
  decimalPlaces: number;
  // Org classification
  industry: string | null;
  businessStructure: string | null;
  // Social media
  socialFacebook: string | null;
  socialLinkedin: string | null;
  socialX: string | null;
  // Regional extended
  invoiceLogoPosition: string;
  roundingMethod: string;
  // Document layouts
  invoiceLayout: 'classic' | 'modern' | 'minimal';
  quoteLayout: 'classic' | 'modern' | 'minimal';
  statementLayout: 'classic' | 'modern' | 'minimal';
  // Customer Zone (portal)
  portalDisplayName: string | null;
  portalTagline: string | null;
  portalMode: 'full' | 'invoices_only' | 'statements_only';
  portalShowAccountBalance: boolean;
  portalShowTransactionHistory: boolean;
  portalAllowPayments: boolean;
  portalPaymentInstructions: string | null;
  portalWelcomeMessage: string | null;
  portalPrimaryColor: string | null;
  // Session UX (PRD-10 Layer 1)
  idleTimeoutMinutes: number;
  // Demo tenant flag
  isDemo: boolean;
}

export interface CompanyUser {
  companyId: string;
  companyName: string;
  role: string;
  isDefault: boolean;
}

// ── Mapper ───────────────────────────────────────────────────────────────────

export function mapCompany(r: Record<string, unknown>): Company {
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
    lockdownEnabled: bool(r.lockdown_enabled, false),
    lockdownDate: r.lockdown_date != null ? fmtDate(r.lockdown_date) : null,
    vatSystemType: r.vat_system_type != null ? String(r.vat_system_type) : 'invoice',
    entityType: r.entity_type != null ? String(r.entity_type) : 'company',
    registeredName: strN(r.registered_name),
    taxOffice: strN(r.tax_office),
    contactName: strN(r.contact_name),
    fax: strN(r.fax),
    mobile: strN(r.mobile),
    physicalAddressLine1: strN(r.physical_address_line1),
    physicalAddressLine2: strN(r.physical_address_line2),
    physicalCity: strN(r.physical_city),
    physicalProvince: strN(r.physical_province),
    physicalPostalCode: strN(r.physical_postal_code),
    taxPractitionerRegNumber: strN(r.tax_practitioner_reg_number),
    taxPractitionerName: strN(r.tax_practitioner_name),
    sarsContactFirstName: strN(r.sars_contact_first_name),
    sarsContactLastName: strN(r.sars_contact_last_name),
    sarsContactCapacity: strN(r.sars_contact_capacity),
    sarsContactNumber: strN(r.sars_contact_number),
    sarsContactTelephone: strN(r.sars_contact_telephone),
    payeReferenceNumber: strN(r.paye_reference_number),
    sdlReferenceNumber: strN(r.sdl_reference_number),
    uifReferenceNumber: strN(r.uif_reference_number),
    sic7Code: strN(r.sic7_code),
    logoPosition: r.logo_position != null ? String(r.logo_position) : 'top-left',
    logoOnEmails: bool(r.logo_on_emails, true),
    logoOnPortal: bool(r.logo_on_portal, true),
    roundingType: r.rounding_type != null ? String(r.rounding_type) : 'none',
    roundToNearest: parseFloat(r.round_to_nearest != null ? String(r.round_to_nearest) : '0'),
    qtyDecimalPlaces: num(r.qty_decimal_places, 2),
    valueDecimalPlaces: num(r.value_decimal_places, 2),
    hoursDecimalPlaces: num(r.hours_decimal_places, 2),
    costPriceDecimalPlaces: num(r.cost_price_decimal_places, 2),
    sellingPriceDecimalPlaces: num(r.selling_price_decimal_places, 2),
    currencySymbol: r.currency_symbol != null ? String(r.currency_symbol) : 'R',
    dateFormat: r.date_format != null ? String(r.date_format) : 'dd/mm/yyyy',
    emailUseForCommunication: bool(r.email_use_for_communication, true),
    emailAlwaysCc: bool(r.email_always_cc, false),
    emailUseServiceFrom: bool(r.email_use_service_from, false),
    warnDuplicateCustomerRef: bool(r.warn_duplicate_customer_ref, true),
    warnDuplicateSupplierInv: bool(r.warn_duplicate_supplier_inv, true),
    displayInactiveCustomersProcessing: bool(r.display_inactive_customers_processing, false),
    displayInactiveSuppliersProcessing: bool(r.display_inactive_suppliers_processing, false),
    displayInactiveCustomersReports: bool(r.display_inactive_customers_reports, false),
    displayInactiveSuppliersReports: bool(r.display_inactive_suppliers_reports, false),
    useInclusiveProcessing: bool(r.use_inclusive_processing, true),
    useAccountDefaultLineType: bool(r.use_account_default_line_type, false),
    warnItemQtyBelowZero: bool(r.warn_item_qty_below_zero, true),
    blockItemQtyBelowZero: bool(r.block_item_qty_below_zero, false),
    warnItemCostZero: bool(r.warn_item_cost_zero, false),
    warnItemSellingBelowCost: bool(r.warn_item_selling_below_cost, false),
    displayInactiveItemsProcessing: bool(r.display_inactive_items_processing, false),
    displayInactiveItemsReports: bool(r.display_inactive_items_reports, false),
    salesOrdersReserveQty: bool(r.sales_orders_reserve_qty, false),
    displayInactiveBundles: bool(r.display_inactive_bundles, false),
    ageingMonthly: bool(r.ageing_monthly, true),
    ageingBasedOn: r.ageing_based_on != null ? String(r.ageing_based_on) : 'invoice_date',
    agingBasis: r.aging_basis != null ? String(r.aging_basis) : 'due_date',
    agingPeriodType: r.aging_period_type != null ? String(r.aging_period_type) : 'monthly',
    agingBucket1Days: num(r.aging_bucket1_days, 30),
    agingBucket2Days: num(r.aging_bucket2_days, 60),
    agingBucket3Days: num(r.aging_bucket3_days, 90),
    invoiceEmailSubject: r.invoice_email_subject != null ? String(r.invoice_email_subject) : 'Invoice {number} from {company}',
    invoiceEmailBody: strN(r.invoice_email_body),
    invoiceEmailSignature: strN(r.invoice_email_signature),
    quoteEmailSubject: r.quote_email_subject != null ? String(r.quote_email_subject) : 'Quote {number} from {company}',
    quoteEmailBody: strN(r.quote_email_body),
    quoteEmailSignature: strN(r.quote_email_signature),
    statementEmailSubject: r.statement_email_subject != null ? String(r.statement_email_subject) : 'Statement from {company}',
    statementEmailBody: strN(r.statement_email_body),
    statementEmailSignature: strN(r.statement_email_signature),
    creditNoteEmailSubject: r.credit_note_email_subject != null ? String(r.credit_note_email_subject) : 'Credit Note {number} from {company}',
    creditNoteEmailBody: strN(r.credit_note_email_body),
    creditNoteEmailSignature: strN(r.credit_note_email_signature),
    salesOrderEmailSubject: r.sales_order_email_subject != null ? String(r.sales_order_email_subject) : 'Sales Order {number} from {company}',
    salesOrderEmailBody: strN(r.sales_order_email_body),
    salesOrderEmailSignature: strN(r.sales_order_email_signature),
    recurringInvoiceEmailSubject: r.recurring_invoice_email_subject != null ? String(r.recurring_invoice_email_subject) : 'Invoice {number} from {company}',
    recurringInvoiceEmailBody: strN(r.recurring_invoice_email_body),
    recurringInvoiceEmailSignature: strN(r.recurring_invoice_email_signature),
    decimalSeparator: r.decimal_separator != null ? String(r.decimal_separator) : '.',
    thousandsSeparator: r.thousands_separator != null ? String(r.thousands_separator) : ',',
    decimalPlaces: num(r.decimal_places, 2),
    industry: strN(r.industry),
    businessStructure: strN(r.business_structure),
    socialFacebook: strN(r.social_facebook),
    socialLinkedin: strN(r.social_linkedin),
    socialX: strN(r.social_x),
    invoiceLogoPosition: r.invoice_logo_position != null ? String(r.invoice_logo_position) : 'top-right',
    roundingMethod: r.rounding_method != null ? String(r.rounding_method) : 'half-up',
    invoiceLayout: (r.invoice_layout != null ? String(r.invoice_layout) : 'classic') as 'classic' | 'modern' | 'minimal',
    quoteLayout: (r.quote_layout != null ? String(r.quote_layout) : 'classic') as 'classic' | 'modern' | 'minimal',
    statementLayout: (r.statement_layout != null ? String(r.statement_layout) : 'classic') as 'classic' | 'modern' | 'minimal',
    // Customer Zone
    portalDisplayName: strN(r.portal_display_name),
    portalTagline: strN(r.portal_tagline),
    portalMode: (r.portal_mode != null ? String(r.portal_mode) : 'full') as 'full' | 'invoices_only' | 'statements_only',
    portalShowAccountBalance: bool(r.portal_show_account_balance, true),
    portalShowTransactionHistory: bool(r.portal_show_transaction_history, true),
    portalAllowPayments: bool(r.portal_allow_payments, true),
    portalPaymentInstructions: strN(r.portal_payment_instructions),
    portalWelcomeMessage: strN(r.portal_welcome_message),
    portalPrimaryColor: strN(r.portal_primary_color),
    idleTimeoutMinutes: num(r.idle_timeout_minutes, 480),
    isDemo: bool(r.is_demo, false),
  };
}
