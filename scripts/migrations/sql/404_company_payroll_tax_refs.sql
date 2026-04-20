-- Migration 399: Payroll tax registration numbers on companies
-- Required for SARS e@syFile IRP5 export (BRS v25.2).
--   paye_reference_number: 10-digit SARS PAYE ref (mandatory for IRP5 certificates — must start with 7 if registered for PAYE)
--   sdl_reference_number:  SARS SDL ref (L + 9 digits)
--   uif_reference_number:  SARS UIF ref (U + 9 digits) — distinct from UIF fund number
--   sic7_code:             Employer SIC7 industry code (5 digits) — mandatory from recon 201402+

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS paye_reference_number VARCHAR(10),
  ADD COLUMN IF NOT EXISTS sdl_reference_number  VARCHAR(10),
  ADD COLUMN IF NOT EXISTS uif_reference_number  VARCHAR(10),
  ADD COLUMN IF NOT EXISTS sic7_code             VARCHAR(5);
