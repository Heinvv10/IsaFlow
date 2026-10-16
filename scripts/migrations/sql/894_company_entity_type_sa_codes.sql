-- 894: companies.entity_type holds one of the eight South African entity codes
-- (src/lib/entityTypes.ts, Hein 2026-10-16):
--   sole_proprietor, partnership, pty_ltd, ltd, cc, npc, trust, other.
--
-- Before: 408 squashed every value into the AFS template keys and installed
-- CHECK (entity_type IN ('pty','cc','trust')), default 'pty'. Company Settings
-- offered 'company', 'sole_proprietor', 'partnership', 'npc' and 'other',
-- which that CHECK refused, so saving any of them failed.
--
-- Data: 'pty' (and NULL, or a legacy 'company' should one survive) becomes
-- 'pty_ltd'; 'cc' and 'trust' keep their codes. The AFS template is now
-- derived from the code (afsTemplateFor): pty_ltd/ltd/npc -> pty, cc -> cc,
-- trust -> trust, others -> the pty fallback AFS always used. So no
-- company's AFS output changes. `business_structure` (286) is left as it is.
--
-- Not purely additive, but loses nothing: no column or row is dropped; the
-- UPDATE rewrites 'pty' to its finer code, and the old CHECK is replaced
-- because it refuses the new codes. The column becomes NOT NULL (every
-- reader already falls back from NULL; nothing writes NULL). The new CHECK is
-- added NOT VALID and validated after the UPDATE in this one transaction
-- (the DROP already holds the table lock, so this only orders the steps).
-- Production before this (2026-10-16, read-only): 16 companies, all 'pty'.
--
-- Deploy order: ship with its code. Until the code is live, a client that
-- sends entity_type 'pty' (the old PIS API schema accepted it; no screen
-- sent it) or 'company' (the old Company Settings select) gets a 500 from the
-- CHECK; before 894 those Settings values were already refused by 408's CHECK.
-- Rollback: DROP the new CHECK and NOT NULL, UPDATE pty_ltd/ltd/npc and the
-- others to 'pty' (lossy), re-add 408's CHECK and default.

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_entity_type_check;

UPDATE public.companies SET entity_type = 'pty_ltd'
WHERE entity_type IS NULL OR entity_type IN ('pty', 'company');

ALTER TABLE public.companies ALTER COLUMN entity_type SET DEFAULT 'pty_ltd';
ALTER TABLE public.companies ALTER COLUMN entity_type SET NOT NULL;

ALTER TABLE public.companies ADD CONSTRAINT companies_entity_type_check CHECK (entity_type IN (
  'sole_proprietor', 'partnership', 'pty_ltd', 'ltd', 'cc', 'npc', 'trust', 'other'
)) NOT VALID;
ALTER TABLE public.companies VALIDATE CONSTRAINT companies_entity_type_check;

COMMENT ON COLUMN public.companies.entity_type IS
  'Legal entity type, one of src/lib/entityTypes.ts ENTITY_TYPE_CODES (894). The AFS template derives from it.';
