-- 717: R-167 — a portal payment link is spent by the payment it started.
-- paystack_payment_requests had no link to the portal_payment_links row a portal
-- checkout came from, so settlement (webhook or verify) could not mark that link
-- paid and a paid link stayed payable. The link's own payment_reference column
-- cannot carry it: a second checkout from the same link would overwrite the first
-- reference before either settles.
--
-- Nullable, no backfill: requests created before this, and every non-portal
-- purpose, have no link. ON DELETE SET NULL keeps a request (money record) when
-- its link row goes.
ALTER TABLE paystack_payment_requests
  ADD COLUMN IF NOT EXISTS portal_payment_link_id UUID
    REFERENCES portal_payment_links(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_paystack_pr_portal_link
  ON paystack_payment_requests (portal_payment_link_id)
  WHERE portal_payment_link_id IS NOT NULL;
