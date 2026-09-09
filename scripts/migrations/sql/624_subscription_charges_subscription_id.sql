-- 624: tie a subscription charge to the subscription it bills.
--
-- subscription_charges only ever carried company_id, so any settlement or
-- failure keyed off a charge acted on every subscription the company owns.
-- Companies with more than one subscription row (no unique constraint on
-- subscriptions.company_id) had a single settled charge grant all of them a
-- free period.
--
-- Every existing charge must end up attributed. A charge left NULL is worse
-- than a wrong one: the duplicate guard in generateDueCharges cannot see it, so
-- the cron queues a replacement and both settle silently against the same
-- period. This migration therefore backfills what it can derive and REFUSES to
-- apply while anything is left over, naming the rows to attribute by hand.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id);

CREATE INDEX IF NOT EXISTS idx_sub_charges_subscription
  ON subscription_charges (subscription_id);

-- Derive through the charge's own mandate: mandate -> company -> the company's
-- single subscription. One subscription is the only unambiguous case.
UPDATE subscription_charges c
SET subscription_id = s.id
FROM subscription_mandates m
JOIN subscriptions s ON s.company_id = m.company_id
WHERE c.subscription_id IS NULL
  AND m.id = c.mandate_id
  AND m.company_id = c.company_id
  AND (SELECT count(*) FROM subscriptions s2 WHERE s2.company_id = m.company_id) = 1;

DO $$
DECLARE
  unattributed INTEGER;
  sample TEXT;
BEGIN
  SELECT count(*) INTO unattributed
  FROM subscription_charges WHERE subscription_id IS NULL;

  IF unattributed > 0 THEN
    SELECT string_agg(format('%s (company %s, %s..%s, %s)',
                             id, company_id, period_start, period_end, status), E'\n  ')
      INTO sample
    FROM (
      SELECT id, company_id, period_start, period_end, status
      FROM subscription_charges WHERE subscription_id IS NULL
      ORDER BY created_at LIMIT 10
    ) t;

    RAISE EXCEPTION E'624: % subscription_charges row(s) could not be attributed to a subscription.\n  Set subscription_id by hand (the company holds more than one subscription), then re-run.\n  First rows:\n  %', unattributed, sample;
  END IF;
END $$;

-- A settled charge must always name its subscription, or the unique index below
-- has a NULL bucket that lets two settlements for one period both through.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_charges_settled_has_subscription'
  ) THEN
    ALTER TABLE subscription_charges
      ADD CONSTRAINT subscription_charges_settled_has_subscription
      CHECK (status <> 'settled' OR subscription_id IS NOT NULL);
  END IF;
END $$;

-- The mandate is per company, so ux_sub_charges_mandate_period_settled (one
-- settled charge per mandate per period, 429_stitch_payments.sql) contradicts a
-- per-subscription charge: a company with two due subscriptions on one mandate
-- had both cards debited and the second settlement rejected with 23505, which
-- the caller recorded as a failure on a charge the customer had already paid.
-- The uniqueness actually wanted is one settled charge per subscription per
-- period, and the CHECK above guarantees the column is never NULL here.
DROP INDEX IF EXISTS ux_sub_charges_mandate_period_settled;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_charges_subscription_period_settled
  ON subscription_charges (mandate_id, subscription_id, period_start, period_end)
  WHERE status = 'settled';
