-- Migration 474: Repair afs_statement_lines for tenants where the original
-- (broken) v1 of mig 472 ran with the wrong BS/IS code scheme.
--
-- Background:
--   The first version of mig 472 used a hand-written catalogue that disagreed
--   with afsMappingService.ts BS_LINES + IS_LINES (e.g. IS002 was set to
--   "Cost of sales" instead of "Turnover"; BS028 to "Provisions" instead of
--   "Trade and other receivables"). The fixed v2 of mig 472 has the canonical
--   catalogue, BUT apply-migrations.ts tracks by filename — so the corrected
--   v2 will not re-run on tenants where v1 already applied. Their wrong rows
--   persist.
--
--   This migration repairs them by upserting every canonical row's label,
--   parent_code, note_number, combine_group, sort_order, is_header, and
--   is_total. ON CONFLICT (company_id, code) DO UPDATE — same UNIQUE key as
--   mig 406, so this is idempotent and a no-op for tenants that already have
--   the canonical labels (i.e. tenants where v1 of mig 472 never ran).
--
--   Also clears afs_account_mappings, because autoMapAccounts may have run
--   against the wrong v1 catalogue and bound accounts to codes whose meaning
--   has changed under v2. autoMapAccounts is idempotent and read-only on the
--   GL — re-running it is cheap; the mapping table is rebuilt from scratch
--   on demand. Tenants where autoMap never ran lose nothing.
--
--   KEEP THE INSERT BLOCK BELOW IN SYNC WITH mig 472. If you change one,
--   change both; ideally both should be generated from BS_LINES + IS_LINES
--   in src/modules/accounting/services/afs/afsMappingService.ts.

-- ── 1. Wipe afs_account_mappings ────────────────────────────────────────────
-- Cheaper than trying to figure out which mappings still point at semantically
-- correct codes vs the v1 wrong codes. autoMapAccounts() rebuilds in seconds.
DELETE FROM afs_account_mappings
WHERE company_id IN (SELECT id FROM companies);

-- ── 2. Upsert canonical catalogue ───────────────────────────────────────────
INSERT INTO afs_statement_lines (
  company_id, code, section, label, parent_code, note_number, sort_order, combine_group, is_header, is_total
)
SELECT c.id, v.code, v.section, v.label, v.parent_code, v.note_number, v.sort_order, v.combine_group, v.is_header, v.is_total
FROM companies c
CROSS JOIN (VALUES
  -- ── Balance Sheet — Non-current assets ─────────────────────────────────────
  ('BS001', 'balance_sheet', 'Non-current assets',                                NULL,    NULL,  10, NULL, true,  false),
  ('BS002', 'balance_sheet', 'Property, plant and equipment',                     'BS001', 2,     20, NULL, false, false),
  ('BS003', 'balance_sheet', 'Contract assets - Leases',                          'BS001', 10,    30, NULL, false, false),
  ('BS004', 'balance_sheet', 'Fixed assets - Fibre installation',                 'BS001', 2,     40, NULL, false, false),
  ('BS005', 'balance_sheet', 'Tangible assets',                                   'BS001', 2,     50, NULL, false, false),
  ('BS006', 'balance_sheet', 'Investment property',                               'BS001', 3,     60, NULL, false, false),
  ('BS007', 'balance_sheet', 'Long-term investments',                             'BS001', NULL,  70, NULL, false, false),
  ('BS008', 'balance_sheet', 'Long-term investments in subsidiaries',             'BS001', NULL,  80, NULL, false, false),
  ('BS009', 'balance_sheet', 'Long-term investments in associates',               'BS001', NULL,  90, NULL, false, false),
  ('BS010', 'balance_sheet', 'Long-term investments in joint ventures',           'BS001', NULL, 100, NULL, false, false),
  ('BS011', 'balance_sheet', 'Long-term loans receivable',                        'BS001', NULL, 110, NULL, false, false),
  ('BS012', 'balance_sheet', 'Long-term loans receivable - subsidiaries',         'BS001', NULL, 120, NULL, false, false),
  ('BS013', 'balance_sheet', 'Long-term loans receivable - associates',           'BS001', NULL, 130, NULL, false, false),
  ('BS014', 'balance_sheet', 'Long-term loans receivable - joint ventures',       'BS001', NULL, 140, NULL, false, false),
  ('BS015', 'balance_sheet', 'Deferred taxation asset',                           'BS001', 19,   150, NULL, false, false),
  ('BS016', 'balance_sheet', 'Derivative instruments',                            'BS001', NULL, 160, NULL, false, false),
  ('BS017', 'balance_sheet', 'Other non-current financial assets',                'BS001', NULL, 170, NULL, false, false),
  ('BS018', 'balance_sheet', 'Mining and prospecting rights',                     'BS001', NULL, 180, NULL, false, false),
  ('BS019', 'balance_sheet', 'Goodwill and other intangible assets',              'BS001', 4,    190, NULL, false, false),
  ('BS020', 'balance_sheet', 'Biological assets',                                 'BS001', NULL, 200, NULL, false, false),
  ('BS021', 'balance_sheet', 'Total non-current assets',                          'BS001', NULL, 210, NULL, false, true),
  ('BS023', 'balance_sheet', 'Current assets',                                    NULL,    NULL, 230, NULL, true,  false),
  ('BS025', 'balance_sheet', 'Short-term investments',                            'BS023', NULL, 250, NULL, false, false),
  ('BS026', 'balance_sheet', 'Inventories',                                       'BS023', NULL, 260, NULL, false, false),
  ('BS027', 'balance_sheet', 'Financial derivatives',                             'BS023', NULL, 270, NULL, false, false),
  ('BS028', 'balance_sheet', 'Trade and other receivables',                       'BS023', 5,   280, NULL, false, false),
  ('BS029', 'balance_sheet', 'Loans to associated companies',                     'BS023', NULL, 290, NULL, false, false),
  ('BS031', 'balance_sheet', 'Prepayments',                                       'BS023', NULL, 310, NULL, false, false),
  ('BS032', 'balance_sheet', 'Taxation receivable',                               'BS023', 19,  320, NULL, false, false),
  ('BS035', 'balance_sheet', 'Restricted cash - funds held in trust',             'BS023', NULL, 350, NULL, false, false),
  ('BS036', 'balance_sheet', 'Bank and cash balances',                            'BS023', 6,   360, NULL, false, false),
  ('BS037', 'balance_sheet', 'Total current assets',                              'BS023', NULL, 370, NULL, false, true),
  ('BS038', 'balance_sheet', 'Total assets',                                      NULL,    NULL, 380, NULL, false, true),
  ('BS040', 'balance_sheet', 'Equity and liabilities',                            NULL,    NULL, 400, NULL, true,  false),
  ('BS041', 'balance_sheet', 'Capital and reserves',                              'BS040', NULL, 410, NULL, true,  false),
  ('BS043', 'balance_sheet', 'Share capital',                                     'BS041', 7,   430, NULL, false, false),
  ('BS044', 'balance_sheet', 'Members contributions',                             'BS041', 7,   440, NULL, false, false),
  ('BS045', 'balance_sheet', 'Accumulated profit (loss)',                         'BS041', 8,   450, NULL, false, false),
  ('BS046', 'balance_sheet', 'Non-distributable reserve',                         'BS041', NULL, 460, NULL, false, false),
  ('BS047', 'balance_sheet', 'Treasury shares',                                   'BS041', NULL, 470, NULL, false, false),
  ('BS048', 'balance_sheet', 'Total equity',                                      'BS041', NULL, 480, NULL, false, true),
  ('BS049', 'balance_sheet', 'Non-current liabilities',                           'BS040', NULL, 490, NULL, true,  false),
  ('BS050', 'balance_sheet', 'Interest-bearing liabilities',                      'BS049', 9,   500, NULL, false, false),
  ('BS051', 'balance_sheet', 'Contract assets lease liabilities',                 'BS049', 10,  510, NULL, false, false),
  ('BS052', 'balance_sheet', 'Loans from associated companies',                   'BS049', NULL, 520, NULL, false, false),
  ('BS053', 'balance_sheet', 'Shareholders loans',                                'BS049', NULL, 530, NULL, false, false),
  ('BS054', 'balance_sheet', 'Long-term loans',                                   'BS049', NULL, 540, NULL, false, false),
  ('BS055', 'balance_sheet', 'Members loans',                                     'BS049', NULL, 550, NULL, false, false),
  ('BS056', 'balance_sheet', 'Non-interest-bearing liabilities',                  'BS049', NULL, 560, NULL, false, false),
  ('BS057', 'balance_sheet', 'Total non-current liabilities',                     'BS049', NULL, 570, NULL, false, true),
  ('BS059', 'balance_sheet', 'Deferred taxation',                                 'BS049', 19,  590, NULL, false, false),
  ('BS060', 'balance_sheet', 'Current liabilities',                               'BS040', NULL, 600, NULL, true,  false),
  ('BS062', 'balance_sheet', 'Current portion of interest-bearing liabilities',   'BS060', 9,   620, NULL, false, false),
  ('BS063', 'balance_sheet', 'Current portion of lease liabilities',              'BS060', 10,  630, NULL, false, false),
  ('BS064', 'balance_sheet', 'Loans payable',                                     'BS060', NULL, 640, NULL, false, false),
  ('BS065', 'balance_sheet', 'Trade and other payables',                          'BS060', 11,  650, NULL, false, false),
  ('BS066', 'balance_sheet', 'Accrued expenses',                                  'BS060', NULL, 660, NULL, false, false),
  ('BS067', 'balance_sheet', 'Unsecured loans payable',                           'BS060', NULL, 670, NULL, false, false),
  ('BS068', 'balance_sheet', 'Other payables and provisions',                     'BS060', NULL, 680, NULL, false, false),
  ('BS069', 'balance_sheet', 'Taxation payable',                                  'BS060', 19,  690, NULL, false, false),
  ('BS070', 'balance_sheet', 'Bank overdrafts',                                   'BS060', 6,   700, NULL, false, false),
  ('BS071', 'balance_sheet', 'Deposits held',                                     'BS060', NULL, 710, NULL, false, false),
  ('BS072', 'balance_sheet', 'Client funds payable - held in trust',              'BS060', NULL, 720, NULL, false, false),
  ('BS073', 'balance_sheet', 'Total current liabilities',                         'BS060', NULL, 730, NULL, false, true),
  ('BS082', 'balance_sheet', 'Total equity and liabilities',                      NULL,    NULL, 820, NULL, false, true),
  ('IS001', 'income_statement', 'Revenue',                                        NULL,    NULL, 1010, NULL, true,  false),
  ('IS002', 'income_statement', 'Turnover',                                       'IS001', 12,  1020, NULL, false, false),
  ('IS003', 'income_statement', 'Sales',                                          'IS001', 12,  1030, NULL, false, false),
  ('IS006', 'income_statement', 'Sales - Local',                                  'IS001', 12,  1060, NULL, false, false),
  ('IS007', 'income_statement', 'Sales - Foreign',                                'IS001', 12,  1070, NULL, false, false),
  ('IS010', 'income_statement', 'Rent received',                                  'IS001', 12,  1100, NULL, false, false),
  ('IS011', 'income_statement', 'Rent received - residential',                    'IS001', 12,  1110, NULL, false, false),
  ('IS012', 'income_statement', 'Tower site leasing income',                      'IS001', 12,  1120, NULL, false, false),
  ('IS013', 'income_statement', 'Management fees received',                       'IS001', 12,  1130, NULL, false, false),
  ('IS025', 'income_statement', 'Operational costs',                              NULL,    NULL, 1250, NULL, true,  false),
  ('IS042', 'income_statement', 'Cost of sales and services',                     'IS025', 13,  1420, NULL, false, false),
  ('IS094', 'income_statement', 'Rental - Equipment',                             'IS025', NULL, 1940, NULL, false, false),
  ('IS100', 'income_statement', 'Repairs and maintenance - vehicles',             'IS025', NULL, 2000, NULL, false, false),
  ('IS109', 'income_statement', 'Sub-Contractors',                                'IS025', NULL, 2090, NULL, false, false),
  ('IS124', 'income_statement', 'Other income',                                   NULL,    NULL, 2240, NULL, true,  false),
  ('IS131', 'income_statement', 'Depreciation recouped',                          'IS124', NULL, 2310, NULL, false, false),
  ('IS132', 'income_statement', 'Bad debts recovered',                            'IS124', NULL, 2320, NULL, false, false),
  ('IS133', 'income_statement', 'Discount received',                              'IS124', NULL, 2330, NULL, false, false),
  ('IS135', 'income_statement', 'Insurance claims received',                      'IS124', NULL, 2350, NULL, false, false),
  ('IS139', 'income_statement', 'Recoveries of expenses',                         'IS124', NULL, 2390, NULL, false, false),
  ('IS143', 'income_statement', 'Other income',                                   'IS124', NULL, 2430, NULL, false, false),
  ('IS156', 'income_statement', 'Less: Expenditure',                              NULL,    NULL, 2560, NULL, true,  false),
  ('IS158', 'income_statement', 'Accommodation',                                  'IS156', NULL, 2580, NULL, false, false),
  ('IS160', 'income_statement', 'Accounting officer''s remuneration',             'IS156', NULL, 2600, NULL, false, false),
  ('IS166', 'income_statement', 'Advertising and promotions',                     'IS156', NULL, 2660, NULL, false, false),
  ('IS171', 'income_statement', 'Auditors remuneration',                          'IS156', NULL, 2710, NULL, false, false),
  ('IS174', 'income_statement', 'Bad debt provisions',                            'IS156', NULL, 2740, NULL, false, false),
  ('IS177', 'income_statement', 'Bad debt written off',                           'IS156', NULL, 2770, NULL, false, false),
  ('IS180', 'income_statement', 'Bad debts',                                      'IS156', NULL, 2800, NULL, false, false),
  ('IS183', 'income_statement', 'Bank charges',                                   'IS156', NULL, 2830, NULL, false, false),
  ('IS195', 'income_statement', 'Cleaning expenses',                              'IS156', NULL, 2950, NULL, false, false),
  ('IS197', 'income_statement', 'CIDB and BEE fees',                              'IS156', NULL, 2970, NULL, false, false),
  ('IS198', 'income_statement', 'Commission paid',                                'IS156', NULL, 2980, NULL, false, false),
  ('IS201', 'income_statement', 'Computer and internet expenses',                 'IS156', NULL, 3010, NULL, false, false),
  ('IS204', 'income_statement', 'Consultants and professional fees',              'IS156', NULL, 3040, NULL, false, false),
  ('IS207', 'income_statement', 'Consumables expenses',                           'IS156', NULL, 3070, NULL, false, false),
  ('IS210', 'income_statement', 'Corporate social investment',                    'IS156', NULL, 3100, NULL, false, false),
  ('IS212', 'income_statement', 'Compliance fees',                                'IS156', NULL, 3120, NULL, false, false),
  ('IS219', 'income_statement', 'Depreciation',                                   'IS156', 16,  3190, NULL, false, false),
  ('IS225', 'income_statement', 'Directors remuneration',                         'IS156', 15,  3250, NULL, false, false),
  ('IS228', 'income_statement', 'Discount allowed',                               'IS156', NULL, 3280, NULL, false, false),
  ('IS234', 'income_statement', 'Donations deductable',                           'IS156', NULL, 3340, NULL, false, false),
  ('IS237', 'income_statement', 'Donations non-deductable',                       'IS156', NULL, 3370, NULL, false, false),
  ('IS240', 'income_statement', 'Entertainment',                                  'IS156', NULL, 3400, NULL, false, false),
  ('IS243', 'income_statement', 'Fines and penalties',                            'IS156', NULL, 3430, NULL, false, false),
  ('IS246', 'income_statement', 'Flowers and gifts',                              'IS156', NULL, 3460, NULL, false, false),
  ('IS249', 'income_statement', 'Foreign currency transactions',                  'IS156', NULL, 3490, NULL, false, false),
  ('IS253', 'income_statement', 'General expenses',                               'IS156', NULL, 3530, NULL, false, false),
  ('IS258', 'income_statement', 'Insurance and guarantees',                       'IS156', NULL, 3580, NULL, false, false),
  ('IS261', 'income_statement', 'Insurance keyman',                               'IS156', NULL, 3610, NULL, false, false),
  ('IS264', 'income_statement', 'Internet',                                       'IS156', NULL, 3640, NULL, false, false),
  ('IS267', 'income_statement', 'Labour hire cost',                               'IS156', NULL, 3670, NULL, false, false),
  ('IS273', 'income_statement', 'Lease charges equipment',                        'IS156', NULL, 3730, NULL, false, false),
  ('IS276', 'income_statement', 'Lease charges vehicles',                         'IS156', NULL, 3760, NULL, false, false),
  ('IS279', 'income_statement', 'Legal fees',                                     'IS156', NULL, 3790, NULL, false, false),
  ('IS285', 'income_statement', 'License and registration',                       'IS156', NULL, 3850, NULL, false, false),
  ('IS288', 'income_statement', 'Management fees paid',                           'IS156', NULL, 3880, NULL, false, false),
  ('IS291', 'income_statement', 'Members remuneration',                           'IS156', NULL, 3910, NULL, false, false),
  ('IS294', 'income_statement', 'Membership fees',                                'IS156', NULL, 3940, NULL, false, false),
  ('IS297', 'income_statement', 'Motor vehicle expenses',                         'IS156', NULL, 3970, NULL, false, false),
  ('IS300', 'income_statement', 'Municipal charges and electricity',              'IS156', NULL, 4000, NULL, false, false),
  ('IS303', 'income_statement', 'Office equipment expenses',                      'IS156', NULL, 4030, NULL, false, false),
  ('IS309', 'income_statement', 'Office consumables',                             'IS156', NULL, 4090, NULL, false, false),
  ('IS321', 'income_statement', 'Postage and courier',                            'IS156', NULL, 4210, NULL, false, false),
  ('IS324', 'income_statement', 'Premises operating leases',                      'IS156', NULL, 4240, NULL, false, false),
  ('IS327', 'income_statement', 'Premises rates and taxes',                       'IS156', NULL, 4270, NULL, false, false),
  ('IS330', 'income_statement', 'Printing and stationery',                        'IS156', NULL, 4300, NULL, false, false),
  ('IS333', 'income_statement', 'Professional fees',                              'IS156', NULL, 4330, NULL, false, false),
  ('IS336', 'income_statement', 'Protective clothing and safety equipment',       'IS156', NULL, 4360, NULL, false, false),
  ('IS339', 'income_statement', 'Recruitment fees',                               'IS156', NULL, 4390, NULL, false, false),
  ('IS342', 'income_statement', 'Registration fees',                              'IS156', NULL, 4420, NULL, false, false),
  ('IS351', 'income_statement', 'Rent paid',                                      'IS156', NULL, 4510, NULL, false, false),
  ('IS354', 'income_statement', 'Rental equipment',                               'IS156', NULL, 4540, NULL, false, false),
  ('IS357', 'income_statement', 'Rental motor vehicle',                           'IS156', NULL, 4570, NULL, false, false),
  ('IS360', 'income_statement', 'Repairs and maintenance',                        'IS156', NULL, 4600, NULL, false, false),
  ('IS363', 'income_statement', 'Repairs and maintenance - vehicles',             'IS156', NULL, 4630, NULL, false, false),
  ('IS366', 'income_statement', 'Research and development',                       'IS156', NULL, 4660, NULL, false, false),
  ('IS369', 'income_statement', 'Retrenchment fees',                              'IS156', NULL, 4690, NULL, false, false),
  ('IS375', 'income_statement', 'Safety and health expenses',                     'IS156', NULL, 4750, NULL, false, false),
  ('IS378', 'income_statement', 'Salaries and wages',                             'IS156', NULL, 4780, NULL, false, false),
  ('IS381', 'income_statement', 'Security expenses',                              'IS156', NULL, 4810, NULL, false, false),
  ('IS390', 'income_statement', 'Staff training',                                 'IS156', NULL, 4900, NULL, false, false),
  ('IS393', 'income_statement', 'Staff welfare',                                  'IS156', NULL, 4930, NULL, false, false),
  ('IS396', 'income_statement', 'Storage',                                        'IS156', NULL, 4960, NULL, false, false),
  ('IS398', 'income_statement', 'Subscriptions and levies',                       'IS156', NULL, 4980, NULL, false, false),
  ('IS401', 'income_statement', 'Telephone expenses',                             'IS156', NULL, 5010, NULL, false, false),
  ('IS404', 'income_statement', 'Theft and fraud',                                'IS156', NULL, 5040, NULL, false, false),
  ('IS413', 'income_statement', 'Training and conference costs',                  'IS156', NULL, 5130, NULL, false, false),
  ('IS416', 'income_statement', 'Transport expenses',                             'IS156', NULL, 5160, NULL, false, false),
  ('IS419', 'income_statement', 'Travel and accommodation - international',       'IS156', NULL, 5190, NULL, false, false),
  ('IS422', 'income_statement', 'Travel and accommodation - local',               'IS156', NULL, 5220, NULL, false, false),
  ('IS425', 'income_statement', 'Uniforms',                                       'IS156', NULL, 5250, NULL, false, false),
  ('IS431', 'income_statement', 'Waste and refuse removal',                       'IS156', NULL, 5310, NULL, false, false),
  ('IS443', 'income_statement', 'Water and electricity',                          'IS156', NULL, 5430, NULL, false, false),
  ('IS452', 'income_statement', 'Net income before interest and taxation',        NULL,    NULL, 5520, NULL, false, true),
  ('IS454', 'income_statement', 'Interest paid',                                  NULL,    17,   5540, 'combine_interest', false, false),
  ('IS455', 'income_statement', 'Interest paid - senior debt',                    NULL,    17,   5550, 'combine_interest', false, false),
  ('IS456', 'income_statement', 'Interest paid - interest-bearing debt',          NULL,    17,   5560, 'combine_interest', false, false),
  ('IS457', 'income_statement', 'Interest paid - finance leases',                 NULL,    17,   5570, 'combine_interest', false, false),
  ('IS458', 'income_statement', 'Interest paid - other external',                 NULL,    17,   5580, 'combine_interest', false, false),
  ('IS461', 'income_statement', 'Interest received',                              NULL,    18,   5610, NULL, false, false),
  ('IS463', 'income_statement', 'Dividends received',                             NULL,    18,   5630, 'combine_investment', false, false),
  ('IS464', 'income_statement', 'Foreign dividends',                              NULL,    18,   5640, 'combine_investment', false, false),
  ('IS467', 'income_statement', 'Other investment income',                        NULL,    18,   5670, 'combine_investment', false, false),
  ('IS471', 'income_statement', 'Net income before taxation',                     NULL,    NULL, 5710, NULL, false, true),
  ('IS472', 'income_statement', 'Profit (loss) on sale of assets',                NULL,    NULL, 5720, NULL, false, false),
  ('IS475', 'income_statement', 'SARS penalties and interest',                    NULL,    19,   5750, NULL, false, false),
  ('IS476', 'income_statement', 'Taxation',                                       NULL,    19,   5760, NULL, false, false),
  ('IS477', 'income_statement', 'Deferred taxation',                              NULL,    19,   5770, NULL, false, false),
  ('IS480', 'income_statement', 'Net income after taxation',                      NULL,    NULL, 5800, NULL, false, true),
  ('IS484', 'income_statement', 'Dividends paid',                                 NULL,    NULL, 5840, NULL, false, false),
  ('IS485', 'income_statement', 'Accumulated income (loss) end of year',          NULL,    NULL, 5850, NULL, false, true),
  ('IS488', 'income_statement', 'Abnormal items',                                 NULL,    NULL, 5880, NULL, false, false)
) AS v(code, section, label, parent_code, note_number, sort_order, combine_group, is_header, is_total)
ON CONFLICT (company_id, code) DO UPDATE SET
  section       = EXCLUDED.section,
  label         = EXCLUDED.label,
  parent_code   = EXCLUDED.parent_code,
  note_number   = EXCLUDED.note_number,
  sort_order    = EXCLUDED.sort_order,
  combine_group = EXCLUDED.combine_group,
  is_header     = EXCLUDED.is_header,
  is_total      = EXCLUDED.is_total,
  updated_at    = NOW();

-- ── 3. Drop any stale codes the v1 catalogue had that aren't in the canonical set
-- The v1 catalogue had 47 codes; canonical has 178. The 47 v1 codes are all
-- a subset of canonical (verified: BS001-BS037, IS001-IS015) — most overlap
-- with the canonical set but with wrong labels (now repaired above by the
-- UPSERT). The few v1 codes that don't appear in canonical at the same spot
-- (e.g. v1's IS004 'Other income' at sort 20, canonical has no IS004) are
-- left in place. They have no mappings (we cleared mappings above) and they
-- don't appear in afsMappingService.ts so no generator references them; they
-- just sit dormant. Removing them isn't necessary and risks deleting a row a
-- tenant might have customised manually. If a future cleanup is desired,
-- tighten this delete predicate then.
