/**
 * Shared merchant-pattern pool — the fixed ISAFlow category list (Hein, 2026-10-21, decision 1).
 *
 * WHY A LIST OF ITS OWN, NOT THE isaflow_standard TEMPLATE. The template (chartOfAccountsImportService.ts
 * ISAFLOW_TEMPLATE) is a TS constant with eight expense accounts (Salaries, Rent, Transport & Fuel, Bank
 * Charges, Admin, Depreciation, Cost of Sales), most of the categories below have no account in it, the
 * template a company chose is stored nowhere, and seed_company_chart_of_accounts (476) seeds the same codes
 * with other names first (5100 Materials & Supplies, 5700 Bank Charges vs the template's 5700 Depreciation).
 * A template code therefore does not name the same thing in two companies, and cannot be a category key.
 *
 * This constant is canonical; migration 905 seeds `merchant_categories` from it and
 * tests/unit/sharedPool/merchantCategories.test.ts fails when the two drift. Adding a category = append
 * here, bump MERCHANT_CATEGORY_LIST_VERSION, and ship a migration that upserts the new row. Never rename or
 * delete a code: published pool rows and company mappings reference it.
 *
 * `poolable: false` — the category exists so a company can map it, but the pool never publishes it
 * (salaries: decision 1, "category only, never pooled from individual names"). The PII filter rejects
 * salary lines anyway; shared_pool_publish (906) refuses a non-poolable category as a second gate.
 *
 * `aliases` drive the one-click auto-map (categoryMappingService.autoMapCategories): a company account
 * whose normalised name equals an alias, and is the only one that does, is proposed for the category.
 * The isaflow_standard and 476 account names are among them, so a company on either chart maps in one
 * click. Every auto-mapped row is shown and editable.
 */

export const MERCHANT_CATEGORY_LIST_VERSION = 1;

export interface MerchantCategory {
  code: string;
  label: string;
  poolable: boolean;
  aliases: readonly string[];
}

export const MERCHANT_CATEGORIES: readonly MerchantCategory[] = [
  { code: 'electricity', label: 'Electricity', poolable: true, aliases: ['ELECTRICITY', 'ELECTRICITY AND POWER', 'POWER'] },
  { code: 'water_rates', label: 'Water, rates & municipal', poolable: true,
    aliases: ['WATER AND RATES', 'RATES AND TAXES', 'RATES AND WATER', 'MUNICIPAL CHARGES', 'MUNICIPAL RATES', 'WATER'] },
  { code: 'telephone', label: 'Telephone & cellphone', poolable: true,
    aliases: ['TELEPHONE', 'TELEPHONE AND FAX', 'CELLPHONE', 'CELLPHONES', 'TELEPHONE AND CELLPHONE', 'COMMUNICATION'] },
  { code: 'internet', label: 'Internet & data', poolable: true, aliases: ['INTERNET', 'INTERNET AND DATA', 'DATA'] },
  { code: 'fuel', label: 'Fuel', poolable: true, aliases: ['FUEL', 'FUEL AND OIL', 'PETROL', 'PETROL AND OIL', 'TRANSPORT AND FUEL', 'MOTOR VEHICLE FUEL'] },
  { code: 'tolls_parking', label: 'Tolls & parking', poolable: true, aliases: ['TOLLS', 'TOLL FEES', 'PARKING', 'TOLLS AND PARKING'] },
  { code: 'motor_vehicle_repairs', label: 'Motor vehicle repairs & maintenance', poolable: true,
    aliases: ['MOTOR VEHICLE EXPENSES', 'MOTOR VEHICLE REPAIRS', 'VEHICLE REPAIRS', 'VEHICLE MAINTENANCE', 'MOTOR VEHICLE MAINTENANCE'] },
  { code: 'bank_charges', label: 'Bank charges', poolable: true, aliases: ['BANK CHARGES', 'BANK FEES', 'BANK CHARGES AND FEES'] },
  { code: 'interest_paid', label: 'Interest paid', poolable: true, aliases: ['INTEREST PAID', 'INTEREST EXPENSE', 'FINANCE COSTS'] },
  { code: 'rent', label: 'Rent', poolable: true, aliases: ['RENT', 'RENT PAID', 'RENTAL', 'RENT AND PREMISES', 'OFFICE RENT'] },
  { code: 'insurance', label: 'Insurance', poolable: true, aliases: ['INSURANCE', 'INSURANCE PREMIUMS', 'SHORT TERM INSURANCE'] },
  { code: 'sars_payments', label: 'SARS payments', poolable: true, aliases: ['SARS', 'SARS PAYMENTS', 'SARS CONTROL'] },
  { code: 'salaries', label: 'Salaries & wages', poolable: false, aliases: ['SALARIES', 'SALARIES AND WAGES', 'WAGES', 'LABOUR COSTS'] },
  { code: 'stationery', label: 'Stationery & printing', poolable: true,
    aliases: ['STATIONERY', 'PRINTING AND STATIONERY', 'STATIONERY AND PRINTING', 'OFFICE SUPPLIES'] },
  { code: 'software_subscriptions', label: 'Software & subscriptions', poolable: true,
    aliases: ['SOFTWARE', 'SOFTWARE SUBSCRIPTIONS', 'SUBSCRIPTIONS', 'COMPUTER SOFTWARE', 'IT EXPENSES'] },
  { code: 'advertising', label: 'Advertising & marketing', poolable: true,
    aliases: ['ADVERTISING', 'ADVERTISING AND MARKETING', 'MARKETING', 'MARKETING AND ADVERTISING'] },
  { code: 'travel', label: 'Travel', poolable: true, aliases: ['TRAVEL', 'TRAVEL LOCAL', 'TRAVEL EXPENSES'] },
  { code: 'accommodation', label: 'Accommodation', poolable: true, aliases: ['ACCOMMODATION'] },
  { code: 'meals_entertainment', label: 'Meals & entertainment', poolable: true,
    aliases: ['ENTERTAINMENT', 'MEALS AND ENTERTAINMENT', 'STAFF MEALS', 'ENTERTAINMENT EXPENSES'] },
  { code: 'courier_postage', label: 'Courier & postage', poolable: true, aliases: ['COURIER', 'COURIER AND POSTAGE', 'POSTAGE', 'COURIER FEES'] },
  { code: 'cleaning', label: 'Cleaning', poolable: true, aliases: ['CLEANING', 'CLEANING AND HYGIENE', 'CLEANING SERVICES'] },
  { code: 'security', label: 'Security', poolable: true, aliases: ['SECURITY', 'SECURITY SERVICES', 'ARMED RESPONSE'] },
  { code: 'professional_fees', label: 'Professional & consulting fees', poolable: true,
    aliases: ['PROFESSIONAL FEES', 'CONSULTING FEES', 'CONSULTANCY FEES'] },
  { code: 'accounting_fees', label: 'Accounting & audit fees', poolable: true,
    aliases: ['ACCOUNTING FEES', 'AUDIT FEES', 'ACCOUNTING AND AUDIT FEES', 'BOOKKEEPING FEES'] },
  { code: 'legal_fees', label: 'Legal fees', poolable: true, aliases: ['LEGAL FEES', 'LEGAL EXPENSES'] },
  { code: 'repairs_maintenance', label: 'Repairs & maintenance', poolable: true,
    aliases: ['REPAIRS AND MAINTENANCE', 'REPAIRS', 'MAINTENANCE', 'BUILDING MAINTENANCE'] },
  { code: 'staff_welfare', label: 'Staff welfare', poolable: true, aliases: ['STAFF WELFARE', 'STAFF REFRESHMENTS'] },
  { code: 'donations', label: 'Donations', poolable: true, aliases: ['DONATIONS', 'CHARITABLE DONATIONS'] },
  { code: 'consumables', label: 'Groceries & consumables', poolable: true,
    aliases: ['CONSUMABLES', 'GROCERIES', 'GROCERIES AND CONSUMABLES', 'REFRESHMENTS'] },
  { code: 'equipment_hire', label: 'Equipment hire', poolable: true, aliases: ['EQUIPMENT HIRE', 'EQUIPMENT RENTAL', 'HIRE OF EQUIPMENT'] },
];

export const MERCHANT_CATEGORY_CODES: ReadonlySet<string> = new Set(MERCHANT_CATEGORIES.map((c) => c.code));

const BY_CODE = new Map(MERCHANT_CATEGORIES.map((c) => [c.code, c]));

export function merchantCategory(code: string): MerchantCategory | undefined {
  return BY_CODE.get(code);
}

/** An account name as the aliases are written: upper case, & as AND, punctuation and extra spaces dropped. */
export function normaliseAccountName(name: string): string {
  return name.toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
