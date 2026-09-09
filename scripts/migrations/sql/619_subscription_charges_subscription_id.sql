-- 619: tie a subscription charge to the subscription it bills.
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
