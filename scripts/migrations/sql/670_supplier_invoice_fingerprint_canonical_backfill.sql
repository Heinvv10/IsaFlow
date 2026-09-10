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
-- The case fold is `translate()` over A-Z, not `lower()`. `lower()` is
-- collation-driven and the TypeScript side cannot reproduce it: in an
-- en_US.utf8 database lower('INV-1') with a Turkish dotted I is `inv-1` while
-- JS `toLowerCase()` yields a six-character string (it appends U+0307), and
-- lower() maps a trailing sigma to a plain one where JS gives a final sigma.
-- invoice_number is free text off a CSV or an OCR read, so a single such
-- character would put this backfill and computeFingerprint out of step -- the
-- same undetected duplicate, one character class over. translate() is a plain
-- character mapping with no collation input, and asciiLower() in
-- captureDeduplicationService.ts performs exactly the same one.
--
-- The join is scoped on company_id as well as supplier_id: a supplier id is a
-- UUID and cannot collide across tenants, but a data migration that reads a
-- second table must say which tenant's row it means.
--
-- That scoping is also what makes the pre-check below necessary. The only FK on
-- supplier_id is to suppliers(id); NOTHING enforces that the supplier belongs
-- to the invoice's company. A row whose supplier is in another tenant is not
-- reachable by the UPDATE, so it would keep a stale fingerprint while the
-- migration reported success — the duplicate lookup for that bill would go on
-- missing, which is the whole defect. Refuse loudly and name the rows instead;
-- there is no correct company to read the VAT number from, and guessing one
-- would write a fingerprint from another tenant's data.

DO $$
DECLARE
  bad_count BIGINT;
  bad_ids   TEXT;
BEGIN
  SELECT count(*) INTO bad_count
  FROM supplier_invoices si
  JOIN suppliers s ON s.id = si.supplier_id
  WHERE s.company_id <> si.company_id;

  IF bad_count > 0 THEN
    -- The sample is capped at 20. A tenant re-parenting accident can produce
    -- thousands of these rows, and a RAISE holding every UUID is a wall of text
    -- the operator cannot act on: the count says how big the problem is, the
    -- first ids make it findable, and the query in fix.md lists the rest.
    SELECT string_agg(id::TEXT, ', ' ORDER BY id) INTO bad_ids
    FROM (
      SELECT si.id
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE s.company_id <> si.company_id
      ORDER BY si.id
      LIMIT 20
    ) sample;

    RAISE EXCEPTION
      'supplier_invoices rows whose supplier belongs to another company cannot be canonicalised: % row(s), first up to 20: %',
      bad_count, bad_ids;
  END IF;
END $$;

UPDATE supplier_invoices si
SET duplicate_fingerprint = translate(
      coalesce(s.vat_number, 'no-vat') || '|' ||
      coalesce(si.invoice_number, 'no-inv') || '|' ||
      coalesce(si.total_amount, 0)::NUMERIC(15,2)::TEXT,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
    )
FROM suppliers s
WHERE s.id = si.supplier_id
  AND s.company_id = si.company_id
  AND si.duplicate_fingerprint IS DISTINCT FROM translate(
      coalesce(s.vat_number, 'no-vat') || '|' ||
      coalesce(si.invoice_number, 'no-inv') || '|' ||
      coalesce(si.total_amount, 0)::NUMERIC(15,2)::TEXT,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
    );
