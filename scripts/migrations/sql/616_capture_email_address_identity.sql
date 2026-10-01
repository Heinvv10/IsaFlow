-- Email destinations are global tenant routing keys, including retired addresses.
-- Never select a winner or silently rotate an address that senders may still use.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower(address) FROM capture_inboxes
    WHERE channel = 'email'
    GROUP BY lower(address) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Email inbox address collisions require reviewed remediation before migration 616';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_capture_inboxes_email_address
  ON capture_inboxes (lower(address)) WHERE channel = 'email';
