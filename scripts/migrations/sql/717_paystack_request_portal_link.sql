-- 717: R-167 — an explicit-amount portal payment link is spent by the payment it started.
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

-- Two kinds of link (Hein, 2026-09-30). The invoice's standing "Pay now" link —
-- the one customer_invoices.payment_url names, minted by pay-now and
-- enableOnlinePayment — charges the LIVE balance and is never spent. An
-- explicit-amount link (portal payment-link POST) charges its own amount, capped
-- at the balance, and one payment spends it. `amount` on a standing link is only
-- the balance when it was minted, so it must not be what it charges.
ALTER TABLE portal_payment_links
  ADD COLUMN IF NOT EXISTS charges_balance BOOLEAN NOT NULL DEFAULT false;

-- Existing standing links: every link an invoice's payment_url points at.
-- Idempotent — a re-run sets nothing new.
UPDATE portal_payment_links l
   SET charges_balance = true
  FROM customer_invoices ci
 WHERE ci.id = l.invoice_id
   AND ci.payment_url IS NOT NULL
   AND ci.payment_url LIKE ('%/portal/pay/' || l.token)
   AND NOT l.charges_balance;
