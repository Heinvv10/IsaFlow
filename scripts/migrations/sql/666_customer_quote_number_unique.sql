-- 666: one quote per company document number (K-107 round 5, HIGH-1)
--
-- `quoteService.nextQuoteNumber` read `SELECT quote_number FROM customer_quotes
-- ORDER BY created_at DESC LIMIT 1` with NO company_id filter, so a company's
-- next quote number was derived from whichever quote was created most recently
-- ACROSS THE WHOLE PLATFORM. That both leaked another tenant's numbering
-- sequence and re-issued numbers a company had already used, whenever the
-- global newest belonged to a tenant sitting on a lower number. Nothing caught
-- it: customer_quotes has never had a uniqueness constraint on its number.
--
-- The service now reserves from company_document_numbers ('quotation'), which
-- is atomic per company. This index is what makes a residual clash with a
-- legacy QUO-nnnnn row FAIL rather than duplicate — it is the constraint
-- `insertWithReservedNumber` retries past, so it must exist and must be named
-- exactly `uq_customer_quotes_company_number`.
--
-- The domain is (company_id, quote_number): unlike a supplier invoice number,
-- a quote number is OUR document number, so a repeat inside one company is
-- always an error. There is no deleted_at column on this table, so the index is
-- total, not partial.
--
-- FAIL-CLOSED, AND LOUDLY, exactly as 646 does: the pre-flight below uses the
-- index's own predicate and grouping, so it cannot report all-clear on a
-- database the index will then refuse, and the offending groups are named
-- rather than left to a CREATE INDEX "Key ... is duplicated" detail that shows
-- only the first collision.

DO $$
DECLARE
  dup_groups INTEGER;
  dup_rows   BIGINT;
  dup_list   TEXT;
  existing_index TEXT;
BEGIN
  -- Detect by COLUMN SET, not by name. A parallel remediation branch (K-060)
  -- adds the same index as uq_customer_quotes_company_quote_number; whichever
  -- merges second must not create a second, redundant unique index over the
  -- same two columns. The service accepts either name when it renumbers.
  SELECT i.relname INTO existing_index
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE x.indrelid = 'public.customer_quotes'::regclass
     AND x.indisunique AND NOT x.indisprimary
     AND x.indexprs IS NULL AND x.indpred IS NULL
     AND x.indkey::text = (
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.customer_quotes'::regclass AND attname = 'company_id')
           || ' ' ||
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.customer_quotes'::regclass AND attname = 'quote_number')
         )
   LIMIT 1;

  IF existing_index IS NOT NULL THEN
    RAISE NOTICE '666: % already enforces unique (company_id, quote_number) — nothing to do.', existing_index;
    RETURN;
  END IF;

  CREATE TEMP TABLE tmp_666_dups ON COMMIT DROP AS
    SELECT company_id, quote_number, count(*) AS n
      FROM customer_quotes
     GROUP BY company_id, quote_number
    HAVING count(*) > 1;

  SELECT count(*), COALESCE(sum(n), 0) INTO dup_groups, dup_rows FROM tmp_666_dups;

  IF dup_groups > 0 THEN
    SELECT string_agg(
             format('company=%s quote_number=%L (%s quotes)', company_id, quote_number, n),
             E'\n  ' ORDER BY n DESC, quote_number)
      INTO dup_list
      FROM (SELECT * FROM tmp_666_dups ORDER BY n DESC, quote_number LIMIT 20) t;

    RAISE EXCEPTION
      'Migration 666 refused: % duplicate (company_id, quote_number) group(s) covering % quotes.%  First % shown:%  %',
      dup_groups, dup_rows, E'\n', least(dup_groups, 20), E'\n  ', dup_list
      USING HINT =
        'These are duplicate quote numbers minted by the unscoped nextQuoteNumber '
        'read. Renumber the extras so each (company_id, quote_number) appears once, '
        'then re-run. See docs/audits/remediation/K-107/fix.md for the probe query.';
  END IF;

  CREATE UNIQUE INDEX uq_customer_quotes_company_number
    ON customer_quotes (company_id, quote_number);

  RAISE NOTICE '666: uq_customer_quotes_company_number created.';
END $$;
