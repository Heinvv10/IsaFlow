-- 993: admin_invoices.send_claimed_at — the claim a platform-invoice Send takes before its email leaves
-- (admin audit 2026-11-14 WP7, review of #1368 M1/M2).
--
-- WHY. The admin Send used to email the customer from inside the request transaction while holding a
-- FOR UPDATE lock on the invoice: a failure after the mail server accepted the message rolled back the
-- audit and email_log rows, and the retry emailed a second copy. Send now runs in three committed steps,
-- none of them across the SMTP call: (1) claim — a draft with no claim gets send_claimed_at = now() and
-- an `invoice.send_started` audit row; (2) the email; (3) finalise — status 'sent' and the claim cleared,
-- or, when the mail server refused it, the claim released with an `invoice.send_failed` audit row.
-- A Send on a claimed invoice is refused (409). When the email left but step 3 failed, the claim STAYS:
-- the invoice shows as a send whose outcome is unknown and is never re-sent automatically; an operator
-- reads the email log and settles it.
--
-- WHAT. One nullable column, no default: every existing row is unclaimed (NULL). Table-level grants on
-- admin_invoices already cover it. ADD COLUMN without a default is catalogue-only (no rewrite).
ALTER TABLE admin_invoices ADD COLUMN IF NOT EXISTS send_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN admin_invoices.send_claimed_at IS
  'Set while an admin Send of this draft is in flight, or when its outcome is unknown (the email may have left). NULL otherwise. Migration 993.';
