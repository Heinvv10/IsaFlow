-- Existing assignments deliberately receive no invented provider proof.
ALTER TABLE capture_inboxes ADD COLUMN IF NOT EXISTS webhook_token_hash text;
ALTER TABLE capture_inboxes ADD COLUMN IF NOT EXISTS provider_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ux_capture_inboxes_webhook_token
  ON capture_inboxes(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS capture_whatsapp_claims (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address ~ '^\+[0-9]{7,15}$'),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE capture_whatsapp_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_whatsapp_claims FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='capture_whatsapp_claims' AND policyname='tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON capture_whatsapp_claims TO app_user
      USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON capture_whatsapp_claims TO app_user, platform_admin;
GRANT ALL ON capture_whatsapp_claims TO migration_admin;
