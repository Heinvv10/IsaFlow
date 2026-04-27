-- Migration 472: Seed default afs_statement_lines catalog for every tenant.
--
-- Background:
--   afs_statement_lines was created by mig 406 but never seeded. As a result,
--   afs_account_mappings can never link accounts to lines, autoMapAccounts()
--   returns 0 mappings, and several note generators silently produce empty
--   notes despite the underlying GL having the data.
--
-- This migration seeds a practical default catalog covering Balance Sheet
-- (BS001–BS035) and Income Statement (IS001–IS020) lines, each linked to its
-- IFRS for SMEs note_number so the existing note engine can resolve them.
--
-- Idempotent: per-tenant ON CONFLICT (company_id, code) DO NOTHING.
-- Pattern follows mig 347.
--
-- Future onboarding (`createCompany` service) should call this same seed —
-- the seed is the catalog, the migration just back-fills existing tenants.

INSERT INTO afs_statement_lines (
  company_id, code, section, label, note_number, sort_order, is_header, is_total
)
SELECT c.id, v.code, v.section, v.label, v.note_number, v.sort_order, v.is_header, v.is_total
FROM companies c
CROSS JOIN (VALUES
  -- ── Balance Sheet ──────────────────────────────────────────────────────────
  -- Non-current assets
  ('BS001', 'balance_sheet', 'Property, plant and equipment',         3,    10, false, false),
  ('BS002', 'balance_sheet', 'Right-of-use assets',                    4,    11, false, false),
  ('BS003', 'balance_sheet', 'Intangible assets',                      5,    12, false, false),
  ('BS004', 'balance_sheet', 'Investment property',                    6,    13, false, false),
  ('BS005', 'balance_sheet', 'Investments in associates',              7,    14, false, false),
  ('BS006', 'balance_sheet', 'Other financial assets',                 8,    15, false, false),
  ('BS007', 'balance_sheet', 'Deferred tax asset',                    17,    16, false, false),
  ('BS010', 'balance_sheet', 'Total non-current assets',              NULL, 20, false, true),

  -- Current assets
  ('BS011', 'balance_sheet', 'Inventories',                            9,    30, false, false),
  ('BS012', 'balance_sheet', 'Trade and other receivables',           10,    31, false, false),
  ('BS013', 'balance_sheet', 'Other current assets',                  NULL,  32, false, false),
  ('BS014', 'balance_sheet', 'Cash and cash equivalents',             11,    33, false, false),
  ('BS015', 'balance_sheet', 'Current tax receivable',                17,    34, false, false),
  ('BS019', 'balance_sheet', 'Total current assets',                  NULL,  40, false, true),
  ('BS020', 'balance_sheet', 'Total assets',                          NULL,  41, false, true),

  -- Equity
  ('BS021', 'balance_sheet', 'Share capital',                         12,    50, false, false),
  ('BS022', 'balance_sheet', 'Reserves',                              12,    51, false, false),
  ('BS023', 'balance_sheet', 'Retained earnings',                     12,    52, false, false),
  ('BS024', 'balance_sheet', 'Total equity',                          NULL,  60, false, true),

  -- Non-current liabilities
  ('BS025', 'balance_sheet', 'Borrowings — non-current',              13,    70, false, false),
  ('BS026', 'balance_sheet', 'Lease liabilities — non-current',       14,    71, false, false),
  ('BS027', 'balance_sheet', 'Deferred tax liability',                17,    72, false, false),
  ('BS028', 'balance_sheet', 'Provisions — non-current',              15,    73, false, false),
  ('BS029', 'balance_sheet', 'Total non-current liabilities',         NULL,  74, false, true),

  -- Current liabilities
  ('BS030', 'balance_sheet', 'Trade and other payables',              16,    80, false, false),
  ('BS031', 'balance_sheet', 'Borrowings — current portion',          13,    81, false, false),
  ('BS032', 'balance_sheet', 'Lease liabilities — current',           14,    82, false, false),
  ('BS033', 'balance_sheet', 'Current tax payable',                   17,    83, false, false),
  ('BS034', 'balance_sheet', 'Provisions — current',                  15,    84, false, false),
  ('BS035', 'balance_sheet', 'Total current liabilities',             NULL,  85, false, true),
  ('BS036', 'balance_sheet', 'Total liabilities',                     NULL,  86, false, true),
  ('BS037', 'balance_sheet', 'Total equity and liabilities',          NULL,  87, false, true),

  -- ── Income Statement ──────────────────────────────────────────────────────
  ('IS001', 'income_statement', 'Revenue',                             18,   10, false, false),
  ('IS002', 'income_statement', 'Cost of sales',                       20,   11, false, false),
  ('IS003', 'income_statement', 'Gross profit',                        NULL, 12, false, true),
  ('IS004', 'income_statement', 'Other income',                        19,   20, false, false),
  ('IS005', 'income_statement', 'Distribution costs',                  20,   21, false, false),
  ('IS006', 'income_statement', 'Administrative expenses',             20,   22, false, false),
  ('IS007', 'income_statement', 'Other operating expenses',            20,   23, false, false),
  ('IS008', 'income_statement', 'Operating profit',                    NULL, 24, false, true),
  ('IS009', 'income_statement', 'Finance income',                      19,   30, false, false),
  ('IS010', 'income_statement', 'Finance costs',                       21,   31, false, false),
  ('IS011', 'income_statement', 'Profit before tax',                   NULL, 32, false, true),
  ('IS012', 'income_statement', 'Income tax expense',                  17,   33, false, false),
  ('IS013', 'income_statement', 'Profit for the year',                 NULL, 34, false, true),
  ('IS014', 'income_statement', 'Other comprehensive income',          NULL, 40, false, false),
  ('IS015', 'income_statement', 'Total comprehensive income',          NULL, 41, false, true)
) AS v(code, section, label, note_number, sort_order, is_header, is_total)
ON CONFLICT (company_id, code) DO NOTHING;
