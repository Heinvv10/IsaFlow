-- Migration 360: Enhance asset_categories with IAS 16 policy + SARS tax fields
-- Adds: useful_life_years, residual_pct, tax_life_years, depreciation_method,
--       ias16_group, capitalization_threshold, tax_code, sars_section
-- Seeds full FAR policy codes from PRD-04 section 3.1

ALTER TABLE asset_categories
  ADD COLUMN IF NOT EXISTS useful_life_years    NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS residual_pct         NUMERIC(5,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_life_years       NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS depreciation_method  TEXT NOT NULL DEFAULT 'straight_line'
    CHECK (depreciation_method IN ('straight_line', 'diminishing_balance')),
  ADD COLUMN IF NOT EXISTS ias16_group          TEXT
    CHECK (ias16_group IN ('PM','MV','FF','OE','CE','LPPE','OA','LEASE') OR ias16_group IS NULL),
  ADD COLUMN IF NOT EXISTS capitalization_threshold NUMERIC(18,2) DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS tax_code             TEXT,
  -- Track which SARS section applies: 11e (general), 12C (manufacturing), 12E (small biz)
  ADD COLUMN IF NOT EXISTS sars_section         TEXT DEFAULT '11e'
    CHECK (sars_section IN ('11e','12C','12E') OR sars_section IS NULL);

-- ─── Seed / update FAR policy codes from PRD-04 section 3.1 ─────────────────
-- Uses INSERT ... ON CONFLICT (code) DO UPDATE so existing rows get the new fields
-- and fresh installs get all rows.

INSERT INTO asset_categories
  (name, code, sars_rate, sars_years, useful_life_years, residual_pct, tax_life_years,
   depreciation_method, ias16_group, capitalization_threshold, tax_code, description)
VALUES
  -- Computer equipment
  ('Computer Equipment',          'CE',    33.33, 3, 4,    0.10, 3,    'straight_line', 'CE',   5000, 'CE',    'General computer equipment'),
  ('Computers (desktops/laptops)','CE1',   33.33, 3, 4,    0.10, 3,    'straight_line', 'CE',   5000, 'CE',    'Desktop and laptop computers'),
  ('Photocopying Equipment',      'CE2',   20.00, 5, 10,   0.10, 5,    'straight_line', 'CE',   5000, 'CE',    'Photocopiers and reprographics'),
  ('Computer Software (PC)',      'CS',    50.00, 2, 5,    0.00, 2,    'straight_line', 'CE',   5000, 'CS',    'Purchased PC software licences'),
  -- AV / production
  ('Edit Suites',                 'Edit',  33.33, 3, 8,    0.10, 3,    'straight_line', 'PM',   5000, 'Edit',  'Video editing and post-production suites'),
  ('TV & Advertising Films',      'Films', 25.00, 4, 2,    0.00, 4,    'straight_line', 'PM',   5000, 'Films', 'TV and advertising film assets'),
  -- Furniture & fittings
  ('Furniture and Fittings',      'FF',    16.67, 6, 10,   0.10, 6,    'straight_line', 'FF',   5000, 'FF',    'Office furniture, fittings and fixtures'),
  ('Office Furniture',            'OF',    16.67, 6, 8,    0.00, 6,    'straight_line', 'FF',   5000, 'FF',    'Desks, chairs, cabinets'),
  -- Generators
  ('Generators – Portable',       'Gen',    6.67,15, 15,   0.15, 5,    'straight_line', 'PM',   5000, 'Gen',   'Portable diesel/petrol generators'),
  ('Generators – Standby',        'GenS',   5.00,20, 20,   0.20, 15,   'straight_line', 'PM',   5000, 'GenS',  'Standby generators and UPS'),
  -- Heavy vehicles
  ('Delivery Trucks/Trailers/LDVs','HD',   20.00, 5, 15,   0.20, 5,    'straight_line', 'MV',   5000, 'HD',    'Delivery trucks, trailers and heavy LDVs'),
  ('Delivery LDVs',               'LDV',   20.00, 5, 7,    0.10, 5,    'straight_line', 'MV',   5000, 'LDV',   'Light delivery vehicles'),
  -- Motor vehicles
  ('Motor Vehicles',              'MV',    20.00, 5, 5,    0.20, 5,    'straight_line', 'MV',   5000, 'MV',    'Passenger and business motor vehicles'),
  -- Office equipment
  ('Office Equipment (Electronic)','OE',   33.33, 3, 3,    0.00, 3,    'straight_line', 'OE',   5000, 'OE',    'Electronic office equipment'),
  -- Photography / cinema
  ('Photographic Equipment',      'PhE',    6.67,15, 15,   0.15, 6,    'straight_line', 'PM',   5000, 'PhE',   'Cameras, lenses and photographic equipment'),
  ('Cinema Equipment',            'CinE',  20.00, 5, 10,   0.10, 5,    'straight_line', 'PM',   5000, 'CinE',  'Cinema projection and sound equipment'),
  -- Production / plant
  ('Production Equipment/Pumps',  'PM',    20.00, 5, 6,    0.10, 5,    'straight_line', 'PM',   5000, 'PM',    'Production machinery, pumps and plant'),
  -- Renewable / security
  ('Solar Energy Units',           'SE',    5.00,20, 20,   0.20, 5,    'straight_line', 'PM',   5000, 'SE',    'Solar panels, inverters and batteries'),
  ('Security Systems (Removable)', 'SecE', 20.00, 5, 10,   0.10, 5,    'straight_line', 'OE',   5000, 'SecE',  'Removable security cameras and access control'),
  -- Telephones
  ('Telephone Equipment',          'Tel', 100.00, 1, 1,    0.00, 2,    'straight_line', 'OE',   5000, 'Tel',   'Fixed-line telephone systems'),
  ('Cellular Telephones',          'Cell', 20.00, 5, 10,   0.10, 5,    'straight_line', 'OE',   5000, 'Cell',  'Mobile phones and cellular devices'),
  -- Special categories (entity-defined life; sars_rate=0 as no fixed SARS rate applies)
  ('Building PPE',                 'LPPE', 0,     0, NULL,  NULL, NULL, 'straight_line', 'LPPE', 5000, 'LPPE',  'Land, plant and property improvements — entity-defined life'),
  ('Other Asset',                  'OA',   0,     0, NULL,  NULL, NULL, 'straight_line', 'OA',   5000, 'OA',    'Miscellaneous assets — entity-defined life'),
  ('Contract Assets – Leases',     'LEASE',0,     0, NULL,  NULL, NULL, 'straight_line', 'LEASE',5000, 'LEASE', 'Right-of-use assets under IFRS 16')
ON CONFLICT (name) DO UPDATE SET
  code                      = EXCLUDED.code,
  useful_life_years         = EXCLUDED.useful_life_years,
  residual_pct              = EXCLUDED.residual_pct,
  tax_life_years            = EXCLUDED.tax_life_years,
  depreciation_method       = EXCLUDED.depreciation_method,
  ias16_group               = EXCLUDED.ias16_group,
  capitalization_threshold  = EXCLUDED.capitalization_threshold,
  tax_code                  = EXCLUDED.tax_code,
  updated_at                = NOW();

CREATE INDEX IF NOT EXISTS idx_asset_categories_ias16_group ON asset_categories(ias16_group);
CREATE INDEX IF NOT EXISTS idx_asset_categories_tax_code    ON asset_categories(tax_code);
