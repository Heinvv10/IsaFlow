-- 671: one stock adjustment per company document number (K-107 round 6, MEDIUM-2)
--
-- `pages/api/accounting/stock-adjustments.ts` minted `ADJ-${COUNT(*)+1}`. A
-- count is not a sequence: it repeats after any deletion, and two concurrent
-- adjustments compute the same count. `stock_adjustments` has never had a
-- uniqueness constraint on its number, so the duplicate was SILENT — two
-- documents moving inventory value under one number, indistinguishable in the
-- list and in any reference to "ADJ-00007".
--
-- The route now reserves from company_document_numbers ('stock_adjustment',
-- prefix ADJ), which is atomic per company. This index is what makes a residual
-- clash with a legacy `ADJ-nnnnn` row FAIL rather than duplicate — it is the
-- constraint `insertWithReservedNumber` retries past, so it must exist and must
-- be named exactly `uq_stock_adjustments_company_number`.
--
-- The domain is (company_id, adjustment_number): the number is OUR document
-- number, so a repeat inside one company is always an error. There is no
-- deleted_at column on this table, so the index is total, not partial.
--
-- FAIL-CLOSED, AND LOUDLY, exactly as 646 and 666 do: the pre-flight below uses
-- the index's own grouping, so it cannot report all-clear on a database the
-- index will then refuse, and the offending groups are named rather than left
-- to a CREATE INDEX "Key ... is duplicated" detail that shows only the first
-- collision. Duplicates are the EXPECTED case on a tenant that has ever deleted
-- a stock adjustment — read the OPERATOR ACTION note in
-- docs/audits/remediation/K-107/fix.md before deploying.

DO $$
DECLARE
  dup_groups INTEGER;
  dup_rows   BIGINT;
  dup_list   TEXT;
  existing_index TEXT;
BEGIN
  -- Detect by COLUMN SET, not by name, so a differently-named index over the
  -- same two columns (from a parallel branch) is not duplicated.
  SELECT i.relname INTO existing_index
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE x.indrelid = 'public.stock_adjustments'::regclass
     AND x.indisunique AND NOT x.indisprimary
     AND x.indexprs IS NULL AND x.indpred IS NULL
     AND x.indkey::text = (
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.stock_adjustments'::regclass AND attname = 'company_id')
           || ' ' ||
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.stock_adjustments'::regclass AND attname = 'adjustment_number')
         )
   LIMIT 1;

  IF existing_index IS NOT NULL THEN
    RAISE NOTICE '671: % already enforces unique (company_id, adjustment_number) — nothing to do.', existing_index;
    RETURN;
  END IF;

  CREATE TEMP TABLE tmp_671_dups ON COMMIT DROP AS
    SELECT company_id, adjustment_number, count(*) AS n
      FROM stock_adjustments
     GROUP BY company_id, adjustment_number
    HAVING count(*) > 1;

  SELECT count(*), COALESCE(sum(n), 0) INTO dup_groups, dup_rows FROM tmp_671_dups;

  IF dup_groups > 0 THEN
    SELECT string_agg(
             format('company=%s adjustment_number=%L (%s adjustments)', company_id, adjustment_number, n),
             E'\n  ' ORDER BY n DESC, adjustment_number)
      INTO dup_list
      FROM (SELECT * FROM tmp_671_dups ORDER BY n DESC, adjustment_number LIMIT 20) t;

    RAISE EXCEPTION
      'Migration 671 refused: % duplicate (company_id, adjustment_number) group(s) covering % adjustments.%  First % shown:%  %',
      dup_groups, dup_rows, E'\n', least(dup_groups, 20), E'\n  ', dup_list
      USING HINT =
        'These are duplicate stock adjustment numbers minted by the COUNT(*)+1 '
        'generator. Renumber the extras so each (company_id, adjustment_number) '
        'appears once, then re-run. See docs/audits/remediation/K-107/fix.md.';
  END IF;

  CREATE UNIQUE INDEX uq_stock_adjustments_company_number
    ON stock_adjustments (company_id, adjustment_number);

  RAISE NOTICE '671: uq_stock_adjustments_company_number created.';
END $$;
