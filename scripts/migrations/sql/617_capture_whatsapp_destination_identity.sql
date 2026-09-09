-- Numbers are tenant routing identities. Legacy collisions need reviewed ownership.
DO $$
BEGIN
  IF EXISTS (
    SELECT btrim(address) FROM capture_inboxes WHERE channel = 'whatsapp'
    GROUP BY btrim(address) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'WhatsApp destination collisions require reviewed remediation before migration 617';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_capture_inboxes_whatsapp_address
  ON capture_inboxes (btrim(address)) WHERE channel = 'whatsapp';
