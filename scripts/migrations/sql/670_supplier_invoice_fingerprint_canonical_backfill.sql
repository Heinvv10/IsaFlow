-- 670 — one canonical duplicate_fingerprint format on supplier_invoices
--
-- `duplicate_fingerprint` had TWO producers that did not agree on the amount
-- segment:
--
--   * migration 412's backfill, in SQL:  coalesce(total_amount::text, '0')
--     — the column is NUMERIC(15,2), so 115 renders as `115.00`;
--   * computeFingerprint(), in TypeScript: the JS number in a template string
--     — 115 renders as `115`.
--
-- 412 backfilled every row that predated it, so every pre-412 bill carries the
-- SQL format while every row written by the application since carries the TS
-- one. A duplicate lookup from the application could not match a backfilled
-- row at all: the AP migration wizard's blank-number guard, the capture
-- pipeline's exact-fingerprint check and the recurring-transaction guard all
-- missed, the bill was created a second time, and a second take-on / accrual
-- journal landed against the payable control account.
--
-- computeFingerprint now formats the amount with two decimals, i.e. the SQL
-- shape. This statement rewrites every stored fingerprint into that same shape
-- so both sides agree on old and new rows alike. It is idempotent (the
-- predicate skips rows already canonical) and re-runnable.
--
-- The join is scoped on company_id as well as supplier_id: a supplier id is a
-- UUID and cannot collide across tenants, but a data migration that reads a
-- second table must say which tenant's row it means.

UPDATE supplier_invoices si
SET duplicate_fingerprint = lower(
      coalesce(s.vat_number, 'no-vat') || '|' ||
      coalesce(si.invoice_number, 'no-inv') || '|' ||
      coalesce(si.total_amount, 0)::NUMERIC(15,2)::TEXT
    )
FROM suppliers s
WHERE s.id = si.supplier_id
  AND s.company_id = si.company_id
  AND si.duplicate_fingerprint IS DISTINCT FROM lower(
      coalesce(s.vat_number, 'no-vat') || '|' ||
      coalesce(si.invoice_number, 'no-inv') || '|' ||
      coalesce(si.total_amount, 0)::NUMERIC(15,2)::TEXT
    );
