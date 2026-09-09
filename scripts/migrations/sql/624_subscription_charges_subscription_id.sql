-- 624: tie a subscription charge to the subscription it bills.
--
-- subscription_charges only ever carried company_id, so any settlement or
-- failure keyed off a charge acted on every subscription the company owns.
-- Companies with more than one subscription row (no unique constraint on
-- subscriptions.company_id) had a single settled charge grant all of them a
-- free period. New charges populate this column; legacy rows are backfilled
-- only where the company has exactly one subscription, which is unambiguous.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id);

CREATE INDEX IF NOT EXISTS idx_sub_charges_subscription
  ON subscription_charges (subscription_id);

UPDATE subscription_charges c
SET subscription_id = s.id
FROM subscriptions s
WHERE c.subscription_id IS NULL
  AND s.company_id = c.company_id
  AND (SELECT COUNT(*) FROM subscriptions s2 WHERE s2.company_id = c.company_id) = 1;

-- The mandate is per company, so ux_sub_charges_mandate_period_settled (one
-- settled charge per mandate per period, 429_stitch_payments.sql) contradicts a
-- per-subscription charge: a company with two due subscriptions on one mandate
-- had both cards debited and the second settlement rejected with 23505, which
-- the caller recorded as a failure on a charge the customer had already paid.
-- The uniqueness that is actually wanted is one settled charge per subscription
-- per period. Rows predating this migration have a NULL subscription_id and
-- collapse onto the mandate, keeping exactly the protection they had.
DROP INDEX IF EXISTS ux_sub_charges_mandate_period_settled;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_charges_subscription_period_settled
  ON subscription_charges (
    mandate_id,
    COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    period_end
  )
  WHERE status = 'settled';

-- Charges this migration could not attribute stay inert: they advance no period
-- and flag no subscription. Report how many need attributing by hand.
DO $$
DECLARE orphaned INTEGER;
BEGIN
  SELECT count(*) INTO orphaned
  FROM subscription_charges
  WHERE subscription_id IS NULL
    AND status IN ('queued','submitted','failed');
  IF orphaned > 0 THEN
    RAISE NOTICE '624: % unattributed live charge(s) — set subscription_id by hand before the next cron run', orphaned;
  END IF;
END $$;
