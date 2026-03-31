-- Migration 279: Create missing bank_accounts and bank_rules tables
-- CRITICAL: bank_accounts is referenced by bank_feed_connections (237_bank_feeds.sql)
-- but was never formally created. The bank_accounts.id column is used as the FK for
-- bank_feed_connections.bank_account_id and in bankFeedService.ts JOINs.
--
-- The existing gl_accounts table with account_subtype = 'bank' serves the
-- bank-accounts API, but the bank feeds system requires a dedicated table
-- for the Stitch OAuth integration to link OAuth tokens to a named account.
--
-- bank_rules is a soft-delete alias used by softDeleteService.ts. It is separate
-- from bank_categorisation_rules (the rule-matching engine). Migration 268 already
-- guarded against its absence with a DO...EXCEPTION block.

-- ── bank_accounts ─────────────────────────────────────────────────────────────
-- Dedicated bank account registry for bank-feed integration.
-- Each row represents a real bank account and can optionally be linked to a
-- corresponding gl_accounts (bank subtype) entry for double-entry bookkeeping.

CREATE TABLE IF NOT EXISTS bank_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id),
  account_name    VARCHAR(255) NOT NULL,
  account_number  VARCHAR(50),
  bank_name       VARCHAR(255),
  branch_code     VARCHAR(20),
  account_type    VARCHAR(50) NOT NULL DEFAULT 'checking',
  gl_account_id   UUID        REFERENCES gl_accounts(id),
  currency        VARCHAR(3)  NOT NULL DEFAULT 'ZAR',
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_company  ON bank_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_gl       ON bank_accounts(gl_account_id) WHERE gl_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_accounts_active   ON bank_accounts(company_id) WHERE is_active = true;

-- Add the FK constraint to bank_feed_connections now that bank_accounts exists.
-- bank_feed_connections.bank_account_id was left as a bare UUID in 237 because
-- the referenced table did not exist at migration time.
DO $$ BEGIN
  ALTER TABLE bank_feed_connections
    ADD CONSTRAINT fk_bfc_bank_account
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);
EXCEPTION
  WHEN duplicate_object   THEN NULL; -- constraint already added
  WHEN undefined_table    THEN NULL; -- bank_feed_connections missing (should not happen)
  WHEN undefined_column   THEN NULL;
END $$;

-- ── bank_rules ────────────────────────────────────────────────────────────────
-- Simple rule table used by softDeleteService.ts for soft-delete / undo support.
-- Distinct from bank_categorisation_rules (the auto-matching engine in 211/256).
-- A bank_rule maps a name pattern to a GL account for quick manual posting.

CREATE TABLE IF NOT EXISTS bank_rules (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id),
  name            VARCHAR(255) NOT NULL,
  match_type      VARCHAR(50)  NOT NULL DEFAULT 'contains'
                    CHECK (match_type IN ('exact', 'contains', 'starts_with', 'ends_with', 'regex')),
  match_field     VARCHAR(50)  NOT NULL DEFAULT 'description'
                    CHECK (match_field IN ('description', 'reference', 'amount', 'both')),
  match_value     TEXT        NOT NULL,
  gl_account_id   UUID        REFERENCES gl_accounts(id),
  tax_rate_id     UUID,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  priority        INTEGER     NOT NULL DEFAULT 0,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_rules_company  ON bank_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_rules_active   ON bank_rules(company_id) WHERE deleted_at IS NULL;
