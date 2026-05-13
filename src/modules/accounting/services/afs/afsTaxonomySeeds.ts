// src/modules/accounting/services/afs/afsTaxonomySeeds.ts
// Static taxonomy data: Balance Sheet lines, Income Statement lines,
// and the account-subtype → AFS code lookup table.
// Imported by afsMappingService (seeder) and afsAutoMapper (heuristics).

import type { AfsLineSection } from './afsMappingService';

// ── Shared seed-line shape ───────────────────────────────────────────────────

export interface SeedLine {
  code: string;
  section: AfsLineSection;
  label: string;
  parentCode?: string;
  noteNumber?: number;
  combineGroup?: string;
  isHeader?: boolean;
  isTotal?: boolean;
}

// ── Balance Sheet taxonomy (79 entries) ─────────────────────────────────────

export const BS_LINES: SeedLine[] = [
  // Non-current assets
  { code: 'BS001', section: 'balance_sheet', label: 'Non-current assets', isHeader: true },
  { code: 'BS002', section: 'balance_sheet', label: 'Property, plant and equipment', parentCode: 'BS001', noteNumber: 2 },
  { code: 'BS003', section: 'balance_sheet', label: 'Contract assets - Leases', parentCode: 'BS001', noteNumber: 10 },
  { code: 'BS004', section: 'balance_sheet', label: 'Fixed assets - Fibre installation', parentCode: 'BS001', noteNumber: 2 },
  { code: 'BS005', section: 'balance_sheet', label: 'Tangible assets', parentCode: 'BS001', noteNumber: 2 },
  { code: 'BS006', section: 'balance_sheet', label: 'Investment property', parentCode: 'BS001', noteNumber: 3 },
  { code: 'BS007', section: 'balance_sheet', label: 'Long-term investments', parentCode: 'BS001' },
  { code: 'BS008', section: 'balance_sheet', label: 'Long-term investments in subsidiaries', parentCode: 'BS001' },
  { code: 'BS009', section: 'balance_sheet', label: 'Long-term investments in associates', parentCode: 'BS001' },
  { code: 'BS010', section: 'balance_sheet', label: 'Long-term investments in joint ventures', parentCode: 'BS001' },
  { code: 'BS011', section: 'balance_sheet', label: 'Long-term loans receivable', parentCode: 'BS001' },
  { code: 'BS012', section: 'balance_sheet', label: 'Long-term loans receivable - subsidiaries', parentCode: 'BS001' },
  { code: 'BS013', section: 'balance_sheet', label: 'Long-term loans receivable - associates', parentCode: 'BS001' },
  { code: 'BS014', section: 'balance_sheet', label: 'Long-term loans receivable - joint ventures', parentCode: 'BS001' },
  { code: 'BS015', section: 'balance_sheet', label: 'Deferred taxation asset', parentCode: 'BS001', noteNumber: 19 },
  { code: 'BS016', section: 'balance_sheet', label: 'Derivative instruments', parentCode: 'BS001' },
  { code: 'BS017', section: 'balance_sheet', label: 'Other non-current financial assets', parentCode: 'BS001' },
  { code: 'BS018', section: 'balance_sheet', label: 'Mining and prospecting rights', parentCode: 'BS001' },
  { code: 'BS019', section: 'balance_sheet', label: 'Goodwill and other intangible assets', parentCode: 'BS001', noteNumber: 4 },
  { code: 'BS020', section: 'balance_sheet', label: 'Biological assets', parentCode: 'BS001' },
  { code: 'BS021', section: 'balance_sheet', label: 'Total non-current assets', parentCode: 'BS001', isTotal: true },

  // Current assets
  { code: 'BS023', section: 'balance_sheet', label: 'Current assets', isHeader: true },
  { code: 'BS025', section: 'balance_sheet', label: 'Short-term investments', parentCode: 'BS023' },
  { code: 'BS026', section: 'balance_sheet', label: 'Inventories', parentCode: 'BS023' },
  { code: 'BS027', section: 'balance_sheet', label: 'Financial derivatives', parentCode: 'BS023' },
  { code: 'BS028', section: 'balance_sheet', label: 'Trade and other receivables', parentCode: 'BS023', noteNumber: 5 },
  { code: 'BS029', section: 'balance_sheet', label: 'Loans to associated companies', parentCode: 'BS023' },
  { code: 'BS031', section: 'balance_sheet', label: 'Prepayments', parentCode: 'BS023' },
  { code: 'BS032', section: 'balance_sheet', label: 'Taxation receivable', parentCode: 'BS023', noteNumber: 19 },
  { code: 'BS035', section: 'balance_sheet', label: 'Restricted cash - funds held in trust', parentCode: 'BS023' },
  { code: 'BS036', section: 'balance_sheet', label: 'Bank and cash balances', parentCode: 'BS023', noteNumber: 6 },
  { code: 'BS037', section: 'balance_sheet', label: 'Total current assets', parentCode: 'BS023', isTotal: true },
  { code: 'BS038', section: 'balance_sheet', label: 'Total assets', isTotal: true },

  // Equity
  { code: 'BS040', section: 'balance_sheet', label: 'Equity and liabilities', isHeader: true },
  { code: 'BS041', section: 'balance_sheet', label: 'Capital and reserves', isHeader: true, parentCode: 'BS040' },
  { code: 'BS043', section: 'balance_sheet', label: 'Share capital', parentCode: 'BS041', noteNumber: 7 },
  { code: 'BS044', section: 'balance_sheet', label: 'Members contributions', parentCode: 'BS041', noteNumber: 7 },
  { code: 'BS045', section: 'balance_sheet', label: 'Accumulated profit (loss)', parentCode: 'BS041', noteNumber: 8 },
  { code: 'BS046', section: 'balance_sheet', label: 'Non-distributable reserve', parentCode: 'BS041' },
  { code: 'BS047', section: 'balance_sheet', label: 'Treasury shares', parentCode: 'BS041' },
  { code: 'BS048', section: 'balance_sheet', label: 'Total equity', parentCode: 'BS041', isTotal: true },

  // Non-current liabilities
  { code: 'BS049', section: 'balance_sheet', label: 'Non-current liabilities', isHeader: true, parentCode: 'BS040' },
  { code: 'BS050', section: 'balance_sheet', label: 'Interest-bearing liabilities', parentCode: 'BS049', noteNumber: 9 },
  { code: 'BS051', section: 'balance_sheet', label: 'Contract assets lease liabilities', parentCode: 'BS049', noteNumber: 10 },
  { code: 'BS052', section: 'balance_sheet', label: 'Loans from associated companies', parentCode: 'BS049' },
  { code: 'BS053', section: 'balance_sheet', label: 'Shareholders loans', parentCode: 'BS049' },
  { code: 'BS054', section: 'balance_sheet', label: 'Long-term loans', parentCode: 'BS049' },
  { code: 'BS055', section: 'balance_sheet', label: 'Members loans', parentCode: 'BS049' },
  { code: 'BS056', section: 'balance_sheet', label: 'Non-interest-bearing liabilities', parentCode: 'BS049' },
  { code: 'BS057', section: 'balance_sheet', label: 'Total non-current liabilities', parentCode: 'BS049', isTotal: true },

  // Deferred tax liability
  { code: 'BS059', section: 'balance_sheet', label: 'Deferred taxation', parentCode: 'BS049', noteNumber: 19 },

  // Current liabilities
  { code: 'BS060', section: 'balance_sheet', label: 'Current liabilities', isHeader: true, parentCode: 'BS040' },
  { code: 'BS062', section: 'balance_sheet', label: 'Current portion of interest-bearing liabilities', parentCode: 'BS060', noteNumber: 9 },
  { code: 'BS063', section: 'balance_sheet', label: 'Current portion of lease liabilities', parentCode: 'BS060', noteNumber: 10 },
  { code: 'BS064', section: 'balance_sheet', label: 'Loans payable', parentCode: 'BS060' },
  { code: 'BS065', section: 'balance_sheet', label: 'Trade and other payables', parentCode: 'BS060', noteNumber: 11 },
  { code: 'BS066', section: 'balance_sheet', label: 'Accrued expenses', parentCode: 'BS060' },
  { code: 'BS067', section: 'balance_sheet', label: 'Unsecured loans payable', parentCode: 'BS060' },
  { code: 'BS068', section: 'balance_sheet', label: 'Other payables and provisions', parentCode: 'BS060' },
  { code: 'BS069', section: 'balance_sheet', label: 'Taxation payable', parentCode: 'BS060', noteNumber: 19 },
  { code: 'BS070', section: 'balance_sheet', label: 'Bank overdrafts', parentCode: 'BS060', noteNumber: 6 },
  { code: 'BS071', section: 'balance_sheet', label: 'Deposits held', parentCode: 'BS060' },
  { code: 'BS072', section: 'balance_sheet', label: 'Client funds payable - held in trust', parentCode: 'BS060' },
  { code: 'BS073', section: 'balance_sheet', label: 'Total current liabilities', parentCode: 'BS060', isTotal: true },
  { code: 'BS082', section: 'balance_sheet', label: 'Total equity and liabilities', isTotal: true },
];

// ── Income Statement taxonomy (126 entries) ──────────────────────────────────

export const IS_LINES: SeedLine[] = [
  // Revenue
  { code: 'IS001', section: 'income_statement', label: 'Revenue', isHeader: true },
  { code: 'IS002', section: 'income_statement', label: 'Turnover', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS003', section: 'income_statement', label: 'Sales', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS006', section: 'income_statement', label: 'Sales - Local', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS007', section: 'income_statement', label: 'Sales - Foreign', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS010', section: 'income_statement', label: 'Rent received', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS011', section: 'income_statement', label: 'Rent received - residential', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS012', section: 'income_statement', label: 'Tower site leasing income', parentCode: 'IS001', noteNumber: 12 },
  { code: 'IS013', section: 'income_statement', label: 'Management fees received', parentCode: 'IS001', noteNumber: 12 },

  // Cost of sales / operational costs
  { code: 'IS025', section: 'income_statement', label: 'Operational costs', isHeader: true },
  { code: 'IS042', section: 'income_statement', label: 'Cost of sales and services', parentCode: 'IS025', noteNumber: 13 },
  { code: 'IS094', section: 'income_statement', label: 'Rental - Equipment', parentCode: 'IS025' },
  { code: 'IS100', section: 'income_statement', label: 'Repairs and maintenance - vehicles', parentCode: 'IS025' },
  { code: 'IS109', section: 'income_statement', label: 'Sub-Contractors', parentCode: 'IS025' },

  // Other income
  { code: 'IS124', section: 'income_statement', label: 'Other income', isHeader: true },
  { code: 'IS131', section: 'income_statement', label: 'Depreciation recouped', parentCode: 'IS124' },
  { code: 'IS132', section: 'income_statement', label: 'Bad debts recovered', parentCode: 'IS124' },
  { code: 'IS133', section: 'income_statement', label: 'Discount received', parentCode: 'IS124' },
  { code: 'IS135', section: 'income_statement', label: 'Insurance claims received', parentCode: 'IS124' },
  { code: 'IS139', section: 'income_statement', label: 'Recoveries of expenses', parentCode: 'IS124' },
  { code: 'IS143', section: 'income_statement', label: 'Other income', parentCode: 'IS124' },

  // Operating expenses
  { code: 'IS156', section: 'income_statement', label: 'Less: Expenditure', isHeader: true },
  { code: 'IS158', section: 'income_statement', label: 'Accommodation', parentCode: 'IS156' },
  { code: 'IS160', section: 'income_statement', label: "Accounting officer's remuneration", parentCode: 'IS156' },
  { code: 'IS166', section: 'income_statement', label: 'Advertising and promotions', parentCode: 'IS156' },
  { code: 'IS171', section: 'income_statement', label: 'Auditors remuneration', parentCode: 'IS156' },
  { code: 'IS174', section: 'income_statement', label: 'Bad debt provisions', parentCode: 'IS156' },
  { code: 'IS177', section: 'income_statement', label: 'Bad debt written off', parentCode: 'IS156' },
  { code: 'IS180', section: 'income_statement', label: 'Bad debts', parentCode: 'IS156' },
  { code: 'IS183', section: 'income_statement', label: 'Bank charges', parentCode: 'IS156' },
  { code: 'IS195', section: 'income_statement', label: 'Cleaning expenses', parentCode: 'IS156' },
  { code: 'IS197', section: 'income_statement', label: 'CIDB and BEE fees', parentCode: 'IS156' },
  { code: 'IS198', section: 'income_statement', label: 'Commission paid', parentCode: 'IS156' },
  { code: 'IS201', section: 'income_statement', label: 'Computer and internet expenses', parentCode: 'IS156' },
  { code: 'IS204', section: 'income_statement', label: 'Consultants and professional fees', parentCode: 'IS156' },
  { code: 'IS207', section: 'income_statement', label: 'Consumables expenses', parentCode: 'IS156' },
  { code: 'IS210', section: 'income_statement', label: 'Corporate social investment', parentCode: 'IS156' },
  { code: 'IS212', section: 'income_statement', label: 'Compliance fees', parentCode: 'IS156' },
  { code: 'IS219', section: 'income_statement', label: 'Depreciation', parentCode: 'IS156', noteNumber: 16 },
  { code: 'IS225', section: 'income_statement', label: 'Directors remuneration', parentCode: 'IS156', noteNumber: 15 },
  { code: 'IS228', section: 'income_statement', label: 'Discount allowed', parentCode: 'IS156' },
  { code: 'IS234', section: 'income_statement', label: 'Donations deductable', parentCode: 'IS156' },
  { code: 'IS237', section: 'income_statement', label: 'Donations non-deductable', parentCode: 'IS156' },
  { code: 'IS240', section: 'income_statement', label: 'Entertainment', parentCode: 'IS156' },
  { code: 'IS243', section: 'income_statement', label: 'Fines and penalties', parentCode: 'IS156' },
  { code: 'IS246', section: 'income_statement', label: 'Flowers and gifts', parentCode: 'IS156' },
  { code: 'IS249', section: 'income_statement', label: 'Foreign currency transactions', parentCode: 'IS156' },
  { code: 'IS253', section: 'income_statement', label: 'General expenses', parentCode: 'IS156' },
  { code: 'IS258', section: 'income_statement', label: 'Insurance and guarantees', parentCode: 'IS156' },
  { code: 'IS261', section: 'income_statement', label: 'Insurance keyman', parentCode: 'IS156' },
  { code: 'IS264', section: 'income_statement', label: 'Internet', parentCode: 'IS156' },
  { code: 'IS267', section: 'income_statement', label: 'Labour hire cost', parentCode: 'IS156' },
  { code: 'IS273', section: 'income_statement', label: 'Lease charges equipment', parentCode: 'IS156' },
  { code: 'IS276', section: 'income_statement', label: 'Lease charges vehicles', parentCode: 'IS156' },
  { code: 'IS279', section: 'income_statement', label: 'Legal fees', parentCode: 'IS156' },
  { code: 'IS285', section: 'income_statement', label: 'License and registration', parentCode: 'IS156' },
  { code: 'IS288', section: 'income_statement', label: 'Management fees paid', parentCode: 'IS156' },
  { code: 'IS291', section: 'income_statement', label: 'Members remuneration', parentCode: 'IS156' },
  { code: 'IS294', section: 'income_statement', label: 'Membership fees', parentCode: 'IS156' },
  { code: 'IS297', section: 'income_statement', label: 'Motor vehicle expenses', parentCode: 'IS156' },
  { code: 'IS300', section: 'income_statement', label: 'Municipal charges and electricity', parentCode: 'IS156' },
  { code: 'IS303', section: 'income_statement', label: 'Office equipment expenses', parentCode: 'IS156' },
  { code: 'IS309', section: 'income_statement', label: 'Office consumables', parentCode: 'IS156' },
  { code: 'IS321', section: 'income_statement', label: 'Postage and courier', parentCode: 'IS156' },
  { code: 'IS324', section: 'income_statement', label: 'Premises operating leases', parentCode: 'IS156' },
  { code: 'IS327', section: 'income_statement', label: 'Premises rates and taxes', parentCode: 'IS156' },
  { code: 'IS330', section: 'income_statement', label: 'Printing and stationery', parentCode: 'IS156' },
  { code: 'IS333', section: 'income_statement', label: 'Professional fees', parentCode: 'IS156' },
  { code: 'IS336', section: 'income_statement', label: 'Protective clothing and safety equipment', parentCode: 'IS156' },
  { code: 'IS339', section: 'income_statement', label: 'Recruitment fees', parentCode: 'IS156' },
  { code: 'IS342', section: 'income_statement', label: 'Registration fees', parentCode: 'IS156' },
  { code: 'IS351', section: 'income_statement', label: 'Rent paid', parentCode: 'IS156' },
  { code: 'IS354', section: 'income_statement', label: 'Rental equipment', parentCode: 'IS156' },
  { code: 'IS357', section: 'income_statement', label: 'Rental motor vehicle', parentCode: 'IS156' },
  { code: 'IS360', section: 'income_statement', label: 'Repairs and maintenance', parentCode: 'IS156' },
  { code: 'IS363', section: 'income_statement', label: 'Repairs and maintenance - vehicles', parentCode: 'IS156' },
  { code: 'IS366', section: 'income_statement', label: 'Research and development', parentCode: 'IS156' },
  { code: 'IS369', section: 'income_statement', label: 'Retrenchment fees', parentCode: 'IS156' },
  { code: 'IS375', section: 'income_statement', label: 'Safety and health expenses', parentCode: 'IS156' },
  { code: 'IS378', section: 'income_statement', label: 'Salaries and wages', parentCode: 'IS156' },
  { code: 'IS381', section: 'income_statement', label: 'Security expenses', parentCode: 'IS156' },
  { code: 'IS390', section: 'income_statement', label: 'Staff training', parentCode: 'IS156' },
  { code: 'IS393', section: 'income_statement', label: 'Staff welfare', parentCode: 'IS156' },
  { code: 'IS396', section: 'income_statement', label: 'Storage', parentCode: 'IS156' },
  { code: 'IS398', section: 'income_statement', label: 'Subscriptions and levies', parentCode: 'IS156' },
  { code: 'IS401', section: 'income_statement', label: 'Telephone expenses', parentCode: 'IS156' },
  { code: 'IS404', section: 'income_statement', label: 'Theft and fraud', parentCode: 'IS156' },
  { code: 'IS413', section: 'income_statement', label: 'Training and conference costs', parentCode: 'IS156' },
  { code: 'IS416', section: 'income_statement', label: 'Transport expenses', parentCode: 'IS156' },
  { code: 'IS419', section: 'income_statement', label: 'Travel and accommodation - international', parentCode: 'IS156' },
  { code: 'IS422', section: 'income_statement', label: 'Travel and accommodation - local', parentCode: 'IS156' },
  { code: 'IS425', section: 'income_statement', label: 'Uniforms', parentCode: 'IS156' },
  { code: 'IS431', section: 'income_statement', label: 'Waste and refuse removal', parentCode: 'IS156' },
  { code: 'IS443', section: 'income_statement', label: 'Water and electricity', parentCode: 'IS156' },

  // Below the line
  { code: 'IS452', section: 'income_statement', label: 'Net income before interest and taxation', isTotal: true },
  { code: 'IS454', section: 'income_statement', label: 'Interest paid', noteNumber: 17, combineGroup: 'combine_interest' },
  { code: 'IS455', section: 'income_statement', label: 'Interest paid - senior debt', noteNumber: 17, combineGroup: 'combine_interest' },
  { code: 'IS456', section: 'income_statement', label: 'Interest paid - interest-bearing debt', noteNumber: 17, combineGroup: 'combine_interest' },
  { code: 'IS457', section: 'income_statement', label: 'Interest paid - finance leases', noteNumber: 17, combineGroup: 'combine_interest' },
  { code: 'IS458', section: 'income_statement', label: 'Interest paid - other external', noteNumber: 17, combineGroup: 'combine_interest' },
  { code: 'IS461', section: 'income_statement', label: 'Interest received', noteNumber: 18 },
  { code: 'IS463', section: 'income_statement', label: 'Dividends received', noteNumber: 18, combineGroup: 'combine_investment' },
  { code: 'IS464', section: 'income_statement', label: 'Foreign dividends', noteNumber: 18, combineGroup: 'combine_investment' },
  { code: 'IS467', section: 'income_statement', label: 'Other investment income', noteNumber: 18, combineGroup: 'combine_investment' },
  { code: 'IS471', section: 'income_statement', label: 'Net income before taxation', isTotal: true },
  { code: 'IS472', section: 'income_statement', label: 'Profit (loss) on sale of assets' },
  { code: 'IS475', section: 'income_statement', label: 'SARS penalties and interest', noteNumber: 19 },
  { code: 'IS476', section: 'income_statement', label: 'Taxation', noteNumber: 19 },
  { code: 'IS477', section: 'income_statement', label: 'Deferred taxation', noteNumber: 19 },
  { code: 'IS480', section: 'income_statement', label: 'Net income after taxation', isTotal: true },
  { code: 'IS484', section: 'income_statement', label: 'Dividends paid' },
  { code: 'IS485', section: 'income_statement', label: 'Accumulated income (loss) end of year', isTotal: true },
  { code: 'IS488', section: 'income_statement', label: 'Abnormal items' },
];

// ── Subtype → AFS code lookup ─────────────────────────────────────────────────

export const SUBTYPE_TO_AFS_CODE: Record<string, string> = {
  // Assets
  fixed_asset:                'BS002',
  accumulated_depreciation:   'BS002',
  bank:                       'BS036',
  receivable:                 'BS028',
  inventory:                  'BS026',
  other_current_asset:        'BS031',
  vat_input:                  'BS032',
  // Liabilities
  payable:                    'BS065',
  other_current_liability:    'BS068',
  vat_output:                 'BS069',
  tax:                        'BS069',
  // Equity
  equity:                     'BS043',
  retained_earnings:          'BS045',
  // Revenue
  default_revenue:            'IS002',
  revenue:                    'IS002',
  other_income:               'IS143',
  // Expenses
  cost_of_sales:              'IS042',
  default_expense:            'IS253',
  operating_expense:          'IS253',
  admin_expense:              'IS160',
  depreciation_expense:       'IS219',
};
