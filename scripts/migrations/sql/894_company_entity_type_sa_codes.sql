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
-- Additive: no column or row is dropped. The old CHECK is replaced, because
-- it refuses the new codes. The new CHECK is added NOT VALID and validated
-- after the UPDATE, in this transaction.
--
-- Deploy order: the code that writes 'pty' (the PIS form's EntityTypeEnum)
-- is replaced in the same PR; old code still writing 'pty' would be refused.
-- Rollback: DROP the new CHECK, UPDATE pty_ltd/ltd/npc -> 'pty', others to
-- 'pty' (lossy), re-add 408's CHECK and default.

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_entity_type_check;

UPDATE public.companies SET entity_type = 'pty_ltd'
WHERE entity_type IS NULL OR entity_type IN ('pty', 'company');

ALTER TABLE public.companies ALTER COLUMN entity_type SET DEFAULT 'pty_ltd';

ALTER TABLE public.companies ADD CONSTRAINT companies_entity_type_check CHECK (entity_type IN (
  'sole_proprietor', 'partnership', 'pty_ltd', 'ltd', 'cc', 'npc', 'trust', 'other'
)) NOT VALID;
ALTER TABLE public.companies VALIDATE CONSTRAINT companies_entity_type_check;

COMMENT ON COLUMN public.companies.entity_type IS
  'Legal entity type, one of src/lib/entityTypes.ts ENTITY_TYPE_CODES (894). The AFS template derives from it.';
