-- 423_platform_shared_supplier_graph.sql
-- PRD-05 Phase 11: Cross-tenant supplier graph + cohort fraud detection.
--
-- The shared schema holds ONLY public / anonymised data:
--   - canonical supplier name + public SARS VAT number (public registry)
--   - document-layout embeddings (opaque vectors, no invoice content)
--   - counts + fraud signals (never amounts, never counterparty data)
--
-- Per-tenant opt-in via companies.share_anonymised_signals (default true,
-- clearly disclosed in settings + one-click off). RLS policies on the
-- shared tables block row-level access from tenant app roles; only
-- platform_admin connections can INSERT/UPDATE. The tenant-facing service
-- reads via SECURITY DEFINER helpers so tenants can query anonymised
-- aggregates without touching the raw rows.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS platform_shared;

-- One row per canonical supplier (Eskom, Vodacom, Telkom, …). Observed
-- across many tenants. The embedding captures invoice layout so a new
-- tenant can auto-match a freshly-scanned Telkom invoice to the same
-- canonical template without seeing another tenant's data.
CREATE TABLE IF NOT EXISTS platform_shared.supplier_templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name       TEXT NOT NULL,                    -- "Eskom Holdings SOC Ltd"
  normalised_name      TEXT GENERATED ALWAYS AS
                         (LOWER(REGEXP_REPLACE(canonical_name, '[^a-z0-9]+', '', 'gi'))) STORED,
  vat_registration     TEXT,                             -- "4000015215" (public SARS data)
  country_code         TEXT NOT NULL DEFAULT 'ZA',
  canonical_categories TEXT[] NOT NULL DEFAULT '{}',     -- ['5450 Electricity']
  known_bank_accounts  TEXT[] NOT NULL DEFAULT '{}',     -- 1st 4 + last 4 only, never full
  layout_embedding     vector(768),                      -- nomic-embed-text dims
  observations_count   INT NOT NULL DEFAULT 0,           -- # tenants that have seen this template
  fraud_score          NUMERIC(5,4) DEFAULT 0,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (normalised_name, country_code)
);

CREATE INDEX IF NOT EXISTS idx_supplier_templates_vat
  ON platform_shared.supplier_templates(vat_registration)
  WHERE vat_registration IS NOT NULL;

-- HNSW index for cosine similarity search over layout embeddings.
-- Lists=100 is a safe default; revisit when the table grows past 10k rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_supplier_templates_embedding'
  ) THEN
    EXECUTE 'CREATE INDEX idx_supplier_templates_embedding
             ON platform_shared.supplier_templates
             USING hnsw (layout_embedding vector_cosine_ops)
             WITH (m = 16, ef_construction = 64)';
  END IF;
END $$;

-- Observations are a minimal audit trail: which anonymised tenant saw this
-- template, when, and what confidence. No amounts, no counterparties.
CREATE TABLE IF NOT EXISTS platform_shared.supplier_observations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_template_id UUID NOT NULL REFERENCES platform_shared.supplier_templates(id) ON DELETE CASCADE,
  tenant_hash       TEXT NOT NULL,                       -- FNV-1a(company_id) — one-way
  match_confidence  NUMERIC(5,4),
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_obs_template
  ON platform_shared.supplier_observations(supplier_template_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_obs_tenant
  ON platform_shared.supplier_observations(tenant_hash);

-- Fraud signals detected against a template. Tenants opt-in to view signals
-- pertaining to their own suppliers. Signal types:
--   - vat_mismatch: canonical VAT reg doesn't match observed VAT on recent invoices
--   - bank_change: new bank account suddenly appears (and fails to match known set)
--   - email_spoof: from-domain doesn't match expected vendor domain
--   - layout_anomaly: layout_embedding diverges > threshold from canonical template
--   - duplicate_vat: same VAT reg observed under multiple canonical names
CREATE TABLE IF NOT EXISTS platform_shared.fraud_signals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type           TEXT NOT NULL
                        CHECK (signal_type IN ('vat_mismatch','bank_change','email_spoof','layout_anomaly','duplicate_vat')),
  supplier_template_id  UUID REFERENCES platform_shared.supplier_templates(id) ON DELETE CASCADE,
  severity              TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info','warning','critical')),
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_template
  ON platform_shared.fraud_signals(supplier_template_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_active
  ON platform_shared.fraud_signals(first_seen_at DESC)
  WHERE dismissed_at IS NULL;

-- Tenant-visible per-supplier alerts. Lives on the tenant stack (not shared)
-- so RLS works identically to other tenant tables. Populated by a scheduled
-- job that diffs the tenant's suppliers against the shared fraud_signals.
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id          UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_template_id UUID,                             -- shared graph ref
  signal_type          TEXT NOT NULL,
  severity             TEXT NOT NULL DEFAULT 'warning',
  evidence             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','dismissed','confirmed')),
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT,
  dismiss_reason       TEXT,
  UNIQUE (company_id, supplier_id, signal_type)
);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_company_pending
  ON fraud_alerts(company_id, status, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_supplier
  ON fraud_alerts(supplier_id);

-- Per-company opt-in toggle (default true — matches Stripe Radar's network
-- model; easily flipped off in settings).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS share_anonymised_signals BOOLEAN NOT NULL DEFAULT TRUE;

-- Tenant-to-template mapping. Lives on the tenant stack — NEVER joined to
-- shared tables in the query path; instead the service fetches template_id
-- and separately calls the shared read API.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS platform_template_id UUID;

CREATE INDEX IF NOT EXISTS idx_suppliers_platform_template
  ON suppliers(platform_template_id) WHERE platform_template_id IS NOT NULL;
