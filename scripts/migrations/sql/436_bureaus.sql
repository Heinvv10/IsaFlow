-- 436_bureaus.sql
-- Bureau mode (multi-client accountant view) — additive, single-tenant users
-- never see the new tables. Adds:
--   * bureaus            — top-level container owned by an accountant
--   * bureau_companies   — many-to-many between bureau ↔ companies it manages
--   * bureau_users       — many-to-many between bureau ↔ users + role per bureau
--   * users.account_type — direct | bureau_owner | bureau_member
--
-- Per VIP/SimplePay/Xero pattern: account_type is set at signup, not toggled
-- per-feature. Single-tenant users keep account_type='direct' and see no
-- bureau routes; bureau accountants land on /bureau and aggregate work
-- across all client companies in their bureau.
--
-- FK to users uses VARCHAR(255) because users.id is varchar(255)::text, not uuid.

CREATE TABLE IF NOT EXISTS bureaus (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  owner_user_id  VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bureaus_owner ON bureaus(owner_user_id);

COMMENT ON TABLE bureaus IS
  'Accountant practice — owns multiple client companies. Created at signup when user picks "I am an accountant".';

CREATE TABLE IF NOT EXISTS bureau_companies (
  bureau_id   UUID NOT NULL REFERENCES bureaus(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by    VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (bureau_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_bureau_companies_company ON bureau_companies(company_id);

COMMENT ON TABLE bureau_companies IS
  'Client companies managed by a bureau. A company can belong to at most one bureau in practice (enforced in app), but the schema does not lock that in case of agency hand-off.';

CREATE TABLE IF NOT EXISTS bureau_users (
  bureau_id   UUID NOT NULL REFERENCES bureaus(id) ON DELETE CASCADE,
  user_id     VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bureau_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bureau_users_user ON bureau_users(user_id);

COMMENT ON TABLE bureau_users IS
  'Users with access to a bureau. owner = full control + billing. accountant = work on all clients. viewer = read-only.';

-- account_type — gates whether the user sees the /bureau routes at all.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'direct'
    CHECK (account_type IN ('direct','bureau_owner','bureau_member'));

CREATE INDEX IF NOT EXISTS idx_users_account_type
  ON users(account_type) WHERE account_type <> 'direct';

COMMENT ON COLUMN users.account_type IS
  'direct = single-tenant user (no bureau UI). bureau_owner = signed up as accountant + owns at least one bureau. bureau_member = was invited into a bureau.';

-- Backfill: any user already in bureau_users gets the matching account_type.
-- (No-op on a fresh deploy — present for re-runs after manual seed.)
UPDATE users u
   SET account_type = 'bureau_owner'
  FROM bureaus b
 WHERE b.owner_user_id = u.id
   AND u.account_type = 'direct';

UPDATE users u
   SET account_type = 'bureau_member'
  FROM bureau_users bu
 WHERE bu.user_id = u.id
   AND u.account_type = 'direct';

-- Capture intent at waitlist signup so we know whether to land them in the
-- direct or bureau onboarding flow when we open the doors. Default 'direct'
-- so existing waitlist rows aren't silently classified as bureaus.
ALTER TABLE waitlist_signups
  ADD COLUMN IF NOT EXISTS signup_type VARCHAR(20) NOT NULL DEFAULT 'direct'
    CHECK (signup_type IN ('direct','accountant')),
  ADD COLUMN IF NOT EXISTS practice_name TEXT;

CREATE INDEX IF NOT EXISTS idx_waitlist_signup_type
  ON waitlist_signups(signup_type) WHERE signup_type = 'accountant';

COMMENT ON COLUMN waitlist_signups.signup_type IS
  'direct = own business, accountant = bureau (manages multiple client companies). Captured at signup, drives onboarding routing at launch.';
COMMENT ON COLUMN waitlist_signups.practice_name IS
  'Accounting practice/firm name — only populated when signup_type=accountant.';
