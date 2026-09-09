import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';
import { assertEffectivePermission, resolveEffectivePermissions } from '@/lib/auth/effectivePermissions';
import { assertControlTx } from '../controls/context';
import { requirePeriodControl, runPeriodControl, type PeriodControlOptions } from '../controls/periodControl';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';
import type { ControlTx } from '../controls/contracts';
import { mapCompany, type Company } from './companyMapper';
type Row = Record<string, unknown>;
export interface LockdownTarget { enabled: boolean; date: string | null }
export interface CompanyControlOptions extends PeriodControlOptions { lockdownIntentId?: string }
export function validateLockdownTarget(target: LockdownTarget): LockdownTarget {
  if (typeof target.enabled !== 'boolean' || (target.date !== null && (typeof target.date !== 'string' || !isRealCalendarDate(target.date)))
    || (target.enabled && target.date === null)) throw new Error('A valid lockdown date is required');
  return { enabled: target.enabled, date: target.date };
}
export async function requestLockdownChange(ctx: ControlTx, target: LockdownTarget) {
  try {
    assertControlTx(ctx); await assertEffectivePermission(ctx, 'write:locks');
    const normalized = validateLockdownTarget(target), intentId = randomUUID();
    return await withSavepoint('request_company_lockdown', async () => {
      await ctx.sql`INSERT INTO control_lockdown_intents(company_id,id,requester_person_id,target_enabled,target_date)
        VALUES(${ctx.principal.companyId}::uuid,${intentId}::uuid,${ctx.principal.personId},${normalized.enabled},${normalized.date}::date)`;
      await recordCommittedChange(ctx, { entityType: 'company_lockdown_intent', entityId: intentId, previousVersion: null, newVersion: 1,
        action: 'lockdown_requested', accountingDate: normalized.date, before: null, after: { requesterPersonId: ctx.principal.personId, ...normalized },
        bindingHash: null, protectedEvidenceRef: null });
      return { intentId, ...normalized };
    });
  } catch (error) { const store = als.getStore(); if (store) store.controlWriteFailed = true; throw error; }
}
export async function updateCompany(id: string, input: Partial<Record<string, unknown>>, options?: CompanyControlOptions): Promise<Company> {
  try {
    const ctx = requirePeriodControl(id);
    const authority = await resolveEffectivePermissions(ctx);
    if (!['owner', 'admin'].includes(authority.role)) throw new Error('Only owners and admins can update company details');
    return await withSavepoint('controlled_company_update', async () => {
      const [before] = await ctx.sql`SELECT * FROM companies WHERE id=${id}::uuid FOR UPDATE` as Row[];
      if (!before) throw new Error('Company not found');
      const existingDate = before.lockdown_date == null ? null : fmtDate(before.lockdown_date as string | Date);
      const target: LockdownTarget = { enabled: input.lockdownEnabled == null ? before.lockdown_enabled === true : input.lockdownEnabled as boolean,
        date: options?.lockdownIntentId && input.lockdownDate === null ? null
          : input.lockdownDate == null || input.lockdownDate === '' ? existingDate : input.lockdownDate as string };
      const changed = target.enabled !== (before.lockdown_enabled === true) || target.date !== existingDate;
      const write = async (operationId?: string) => {
        const ref = { entityType: 'company', entityId: id }, version = await readControlEntityVersion(ctx, ref);
        let previousVersion = version?.version ?? 0;
        if (!version) previousVersion = (await recordCommittedChange(ctx, { ...ref, previousVersion: null, newVersion: 1,
          action: 'baseline_observed', accountingDate: null, before: null, after: before, bindingHash: null, protectedEvidenceRef: null })).newVersion;
        const result = await updateCompanyRow(id, input, operationId ? target : undefined);
        const [after] = await ctx.sql`SELECT * FROM companies WHERE id=${id}::uuid` as Row[];
        await recordCommittedChange(ctx, { ...ref, previousVersion, newVersion: previousVersion + 1,
          action: changed ? 'company_lockdown_changed' : 'company_updated', accountingDate: target.date, before, after: after!,
          bindingHash: null, protectedEvidenceRef: null, ...(operationId ? { operationId } : {}) });
        return result;
      };
      if (!changed && !options?.lockdownIntentId) return write();
      validateLockdownTarget(target);
      if (!options?.lockdownIntentId) throw new Error('A persisted lockdown intent and operation approval reference are required');
      const [intent] = await ctx.sql`SELECT requester_person_id,target_enabled,target_date::text FROM control_lockdown_intents
        WHERE company_id=${id}::uuid AND id=${options.lockdownIntentId}::uuid` as Row[];
      if (!intent || intent.requester_person_id !== ctx.principal.personId || intent.target_enabled !== target.enabled || intent.target_date !== target.date) {
        throw new Error('Lockdown target or requester does not match the persisted intent');
      }
      return runPeriodControl(id, { entityType: 'company_lockdown_intent', entityId: options.lockdownIntentId, operation: 'company_lockdown.change' }, options,
        async (_active, permit) => write(permit.operationId));
    });
  } catch (error) { const store = als.getStore(); if (store) store.controlWriteFailed = true; throw error; }
}

async function updateCompanyRow(id: string, input: Partial<Record<string, unknown>>, lockTarget?: LockdownTarget): Promise<Company> {
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
      lockdown_date = CASE WHEN ${lockTarget !== undefined} THEN ${lockTarget?.date ?? null}::date
        ELSE COALESCE(${v('lockdownDate') ?? null}::date, lockdown_date) END,
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
      paye_reference_number = COALESCE(${v('payeReferenceNumber') ?? null}, paye_reference_number),
      sdl_reference_number = COALESCE(${v('sdlReferenceNumber') ?? null}, sdl_reference_number),
      uif_reference_number = COALESCE(${v('uifReferenceNumber') ?? null}, uif_reference_number),
      sic7_code = COALESCE(${v('sic7Code') ?? null}, sic7_code),
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
      invoice_email_signature = COALESCE(${v('invoiceEmailSignature') ?? null}, invoice_email_signature),
      quote_email_subject = COALESCE(${v('quoteEmailSubject') ?? null}, quote_email_subject),
      quote_email_body = COALESCE(${v('quoteEmailBody') ?? null}, quote_email_body),
      quote_email_signature = COALESCE(${v('quoteEmailSignature') ?? null}, quote_email_signature),
      statement_email_subject = COALESCE(${v('statementEmailSubject') ?? null}, statement_email_subject),
      statement_email_body = COALESCE(${v('statementEmailBody') ?? null}, statement_email_body),
      statement_email_signature = COALESCE(${v('statementEmailSignature') ?? null}, statement_email_signature),
      credit_note_email_subject = COALESCE(${v('creditNoteEmailSubject') ?? null}, credit_note_email_subject),
      credit_note_email_body = COALESCE(${v('creditNoteEmailBody') ?? null}, credit_note_email_body),
      credit_note_email_signature = COALESCE(${v('creditNoteEmailSignature') ?? null}, credit_note_email_signature),
      sales_order_email_subject = COALESCE(${v('salesOrderEmailSubject') ?? null}, sales_order_email_subject),
      sales_order_email_body = COALESCE(${v('salesOrderEmailBody') ?? null}, sales_order_email_body),
      sales_order_email_signature = COALESCE(${v('salesOrderEmailSignature') ?? null}, sales_order_email_signature),
      recurring_invoice_email_subject = COALESCE(${v('recurringInvoiceEmailSubject') ?? null}, recurring_invoice_email_subject),
      recurring_invoice_email_body = COALESCE(${v('recurringInvoiceEmailBody') ?? null}, recurring_invoice_email_body),
      recurring_invoice_email_signature = COALESCE(${v('recurringInvoiceEmailSignature') ?? null}, recurring_invoice_email_signature),
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
      invoice_layout = COALESCE(${v('invoiceLayout') ?? null}, invoice_layout),
      quote_layout = COALESCE(${v('quoteLayout') ?? null}, quote_layout),
      statement_layout = COALESCE(${v('statementLayout') ?? null}, statement_layout),
      portal_display_name = COALESCE(${v('portalDisplayName') ?? null}, portal_display_name),
      portal_tagline = COALESCE(${v('portalTagline') ?? null}, portal_tagline),
      portal_mode = COALESCE(${v('portalMode') ?? null}, portal_mode),
      portal_show_account_balance = COALESCE(${v('portalShowAccountBalance') ?? null}, portal_show_account_balance),
      portal_show_transaction_history = COALESCE(${v('portalShowTransactionHistory') ?? null}, portal_show_transaction_history),
      portal_allow_payments = COALESCE(${v('portalAllowPayments') ?? null}, portal_allow_payments),
      portal_payment_instructions = COALESCE(${v('portalPaymentInstructions') ?? null}, portal_payment_instructions),
      portal_welcome_message = COALESCE(${v('portalWelcomeMessage') ?? null}, portal_welcome_message),
      portal_primary_color = COALESCE(${v('portalPrimaryColor') ?? null}, portal_primary_color),
      idle_timeout_minutes = COALESCE(${v('idleTimeoutMinutes') ?? null}::int, idle_timeout_minutes),
      updated_at = NOW()
    WHERE id = ${id}::UUID RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Company ${id} not found`);
  return mapCompany(rows[0]);
}

