-- Migration 976: the identity document an employee holds, for ETI (wave 5 ET review round 2, Hein ruling on adv M4)
-- 2026-11-11 | feat/mp-w5-eti
--
-- WHY. ETI Act s6(b): a qualifying employee is in possession of (i) an identity card (Identification Act s14), (ii) an
-- asylum seeker permit (Refugees Act s22(1)) or (iii) a refugee identity document (Refugees Act s30) (SARS Guide to the
-- Employment Tax Incentive, Issue 5, §3.2.2 p. 25). The calculator claims ETI only when one is shown: a valid South
-- African ID number (13 digits, a real date of birth, the Luhn check digit), or this column naming a permit or refugee ID.
--
-- eti_id_document: NULL or 'sa_id' = the ID number decides; 'asylum_seeker_permit' / 'refugee_id' = held, as recorded.
-- Nullable, no default, no backfill: every existing employee keeps today's reading (the ID number decides).
-- Re-runnable: ADD COLUMN IF NOT EXISTS, and the CHECK is added only when absent.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS eti_id_document TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employees_eti_id_document_check'
                   AND conrelid = 'public.payroll_employees'::regclass) THEN
    ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_eti_id_document_check
      CHECK (eti_id_document IS NULL OR eti_id_document IN ('sa_id', 'asylum_seeker_permit', 'refugee_id'));
  END IF;
END
$$;

COMMENT ON COLUMN public.payroll_employees.eti_id_document IS
  'ETI Act s6(b): NULL or sa_id = the ID number decides; asylum_seeker_permit / refugee_id = the employee holds one (migration 976).';
