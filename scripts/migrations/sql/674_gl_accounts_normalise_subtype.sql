-- 674: gl_accounts.account_subtype is stored in the SAME shape the reporting
-- vocabulary looks a spelling up in.
--
-- `canonicalSubtype` (src/modules/accounting/services/gl/accountSubtypes.ts)
-- trims, lower-cases and collapses runs of whitespace/hyphen to '_' BEFORE it
-- looks a spelling up in SUBTYPE_ALIASES. Roughly ninety SQL filters compare
-- the RAW column against `rawSubtypesFor(...)`, whose entries are exactly the
-- normalised keys of that map. The two therefore disagree on any stored value
-- that differs only in case or separator: an account stored 'COGS' banded as
-- cost of sales on the income statement (via canonicalSubtype) and as an
-- operating expense inside AFS note 20 (via the raw comparison), and one
-- stored 'Finance Cost' was double-counted in note 20 while note 21 printed
-- nil — the same statutory pack disagreeing with itself over one account.
--
-- gl_accounts.account_subtype is a plain varchar(50) with no CHECK, and
-- several writers (this directory's own migrations, sageMigrationOrchestrator,
-- migrationCoaService, the seed scripts) never reach `subtypeErrorFor`. So the
-- fix belongs at the column, not at ninety call sites: normalise on write and
-- every one of those comparisons is correct by construction.
--
-- A trigger rather than a CHECK deliberately: a CHECK would make an importer
-- writing 'COGS' fail outright, where normalising it stores the spelling the
-- vocabulary already recognises. Values outside the vocabulary are normalised
-- too and still canonicalise to NULL, which is reported as unclassified — the
-- behaviour is unchanged for them.

CREATE OR REPLACE FUNCTION gl_accounts_normalise_subtype()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_subtype IS NOT NULL THEN
    -- The SQL twin of canonicalSubtype's
    -- raw.trim().toLowerCase().replace(/[\s-]+/g, '_'). A value that is only
    -- whitespace collapses to '' there and returns null; NULLIF reproduces it.
    NEW.account_subtype := NULLIF(
      lower(regexp_replace(btrim(NEW.account_subtype), '[[:space:]-]+', '_', 'g')),
      ''
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gl_accounts_normalise_subtype ON gl_accounts;
CREATE TRIGGER trg_gl_accounts_normalise_subtype
  BEFORE INSERT OR UPDATE OF account_subtype ON gl_accounts
  FOR EACH ROW
  EXECUTE FUNCTION gl_accounts_normalise_subtype();

-- Backfill. Deliberately NOT scoped by company_id: this normalises a shared
-- vocabulary column, not one tenant's data, and leaving one tenant behind is
-- exactly the divergence the trigger exists to end. It touches only rows that
-- are not already normalised: zero of 4,026 accounts in isaflow_dev on
-- 2026-09-10. Production not measured; its row count is impact SQL for Hein:
--   SELECT count(*) FROM gl_accounts WHERE account_subtype IS NOT NULL
--     AND account_subtype IS DISTINCT FROM NULLIF(lower(regexp_replace(
--       btrim(account_subtype), '[[:space:]-]+', '_', 'g')), '');
UPDATE gl_accounts
SET account_subtype = NULLIF(
      lower(regexp_replace(btrim(account_subtype), '[[:space:]-]+', '_', 'g')),
      ''
    )
WHERE account_subtype IS NOT NULL
  AND account_subtype IS DISTINCT FROM NULLIF(
        lower(regexp_replace(btrim(account_subtype), '[[:space:]-]+', '_', 'g')),
        ''
      );
