-- 719: R-179 — the invoice's standing "Pay now" link does not expire.
-- portal_payment_links.expires_at defaults to 30 days. That suits an explicit-amount
-- link, but the standing link is the one an invoice's payment_url names and the one
-- emailed with the invoice: after 30 days the customer met "Payment link expired"
-- on an invoice that still owed money. New standing links are minted with no expiry
-- (standingPaymentLink.ts); this clears the expiry of the ones that already exist.
--
-- Only the active link an invoice's payment_url names. Every link from before 717
-- carries charges_balance = true, including old explicit-amount links, and those must
-- not come back to life; a cancelled or paid link stays as it is. The column default
-- stays, for explicit-amount links.
--
-- Data only, no DDL. Idempotent.
SET LOCAL lock_timeout = '5s';

UPDATE portal_payment_links l
SET expires_at = NULL
FROM customer_invoices ci
WHERE ci.id = l.invoice_id
  AND l.charges_balance
  AND l.status = 'active'
  AND l.expires_at IS NOT NULL
  AND ci.payment_url LIKE '%/portal/pay/' || l.token;
