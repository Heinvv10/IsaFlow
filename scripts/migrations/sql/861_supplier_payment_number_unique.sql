-- Migration 861: unique (company_id, payment_number) on supplier_payments.
-- 2026-10-06 | fix/doc-number-races-20261006
--
-- supplier_payments had no unique index on its number, so two concurrent inserts that the
-- numbering trigger gave the same number were both stored. Migration 858
-- serialises the trigger; this index refuses a duplicate from any other source
-- (an explicit number). Scope = exactly what the trigger numbers within.
--
-- Created only when the table holds no duplicate: CREATE UNIQUE INDEX fails
-- 23505 on an existing duplicate, and the EXCEPTION block turns that into a
-- NOTICE and leaves the table without the index, so existing data can never
-- fail a deploy. A NOTICE in the deploy log means: dedupe, then create the index
-- by hand with the statement below. (isaflow_dev, read 2026-10-06: no duplicate.)
-- NULL numbers never conflict in a unique index, so it is not partial.
--
-- One index per migration file: the runner (scripts/apply-migrations.ts) runs
-- each file in its own transaction, so this file holds only supplier_payments's SHARE
-- lock, for the length of one index build, and never waits for another table
-- while holding it. lock_timeout bounds the wait to acquire it.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payments_company_number ON public.supplier_payments (company_id, payment_number);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '861: supplier_payments holds a duplicate (company_id, payment_number); uq_supplier_payments_company_number NOT created. Dedupe, then create it by hand (861_supplier_payment_number_unique.sql)';
END $$;
