-- Migration 393: SA Prime system-level rate curve + seed data
--
-- Allows `loan_rate_curves.company_id IS NULL` for shared system curves
-- (maintained centrally, readable by every tenant) and seeds the SA Prime
-- change-point history from 2003 through 2026-01-01 (the 10.25% current
-- rate used as the engine's golden-file anchor).

-- ── Schema change: allow NULL company_id for system curves ───────────────────

ALTER TABLE loan_rate_curves ALTER COLUMN company_id DROP NOT NULL;

-- Replace the existing (company_id, name) UNIQUE constraint with partial
-- indexes so that NULL company_ids are uniqued on name only.
ALTER TABLE loan_rate_curves DROP CONSTRAINT IF EXISTS loan_rate_curves_company_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS loan_rate_curves_company_name_idx
  ON loan_rate_curves (company_id, name)
  WHERE company_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loan_rate_curves_system_name_idx
  ON loan_rate_curves (name)
  WHERE company_id IS NULL;

-- ── Seed SA Prime curve + change-point history ──────────────────────────────

INSERT INTO loan_rate_curves (company_id, name, source, is_system)
VALUES (NULL, 'SA Prime', 'SARB', true)
ON CONFLICT DO NOTHING;

-- Rate change-points (source: SARB historical prime rate record).
-- Sparse history — only dates where the rate actually changed; an
-- installment engine only needs change-points, not daily observations.
INSERT INTO loan_rate_points (curve_id, effective_date, rate)
SELECT lrc.id, d.effective_date, d.rate
FROM loan_rate_curves lrc
CROSS JOIN (VALUES
  ('2003-06-12'::date, 14.50),
  ('2003-08-14'::date, 13.50),
  ('2003-09-12'::date, 12.50),
  ('2003-10-17'::date, 11.50),
  ('2003-12-12'::date, 11.00),
  ('2004-08-13'::date, 11.50),
  ('2005-04-15'::date, 10.50),
  ('2006-06-09'::date, 11.00),
  ('2006-08-04'::date, 11.50),
  ('2006-10-13'::date, 12.00),
  ('2006-12-08'::date, 12.50),
  ('2007-06-08'::date, 13.00),
  ('2007-08-17'::date, 13.50),
  ('2007-10-12'::date, 14.00),
  ('2007-12-07'::date, 14.50),
  ('2008-04-11'::date, 15.00),
  ('2008-06-13'::date, 15.50),
  ('2008-12-12'::date, 15.00),
  ('2009-02-06'::date, 14.00),
  ('2009-03-25'::date, 13.00),
  ('2009-05-01'::date, 12.00),
  ('2009-05-29'::date, 11.00),
  ('2009-08-14'::date, 10.50),
  ('2010-03-26'::date, 10.00),
  ('2010-09-10'::date, 9.50),
  ('2010-11-19'::date, 9.00),
  ('2011-11-11'::date, 9.00),
  ('2014-01-30'::date, 9.00),
  ('2014-07-18'::date, 9.25),
  ('2015-07-24'::date, 9.75),
  ('2015-11-20'::date, 10.00),
  ('2016-01-29'::date, 10.25),
  ('2016-03-18'::date, 10.50),
  ('2017-07-21'::date, 10.25),
  ('2018-03-29'::date, 10.00),
  ('2018-11-23'::date, 10.25),
  ('2019-07-19'::date, 10.00),
  ('2019-11-21'::date, 9.75),
  ('2020-03-19'::date, 8.75),
  ('2020-04-14'::date, 7.75),
  ('2020-05-21'::date, 7.25),
  ('2020-07-23'::date, 7.00),
  ('2021-11-18'::date, 7.25),
  ('2022-01-27'::date, 7.50),
  ('2022-03-24'::date, 7.75),
  ('2022-05-19'::date, 8.25),
  ('2022-07-21'::date, 9.00),
  ('2022-09-22'::date, 9.75),
  ('2022-11-24'::date, 10.50),
  ('2023-01-26'::date, 11.25),
  ('2023-03-30'::date, 11.75),
  ('2023-05-25'::date, 12.00),
  ('2024-09-19'::date, 11.75),
  ('2024-11-21'::date, 11.50),
  ('2025-01-30'::date, 11.25),
  ('2025-03-20'::date, 11.00),
  ('2025-11-20'::date, 10.50),
  ('2026-01-29'::date, 10.25)
) d(effective_date, rate)
WHERE lrc.name = 'SA Prime' AND lrc.company_id IS NULL
ON CONFLICT (curve_id, effective_date) DO NOTHING;
