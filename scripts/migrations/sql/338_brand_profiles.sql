-- Plan 4 / AFS Export — brand profile per company
CREATE TABLE IF NOT EXISTS brand_profiles (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  logo_url       TEXT,
  primary_colour VARCHAR(7)  NOT NULL DEFAULT '#1a3a5c',  -- hex e.g. '#1a3a5c'
  secondary_colour VARCHAR(7) NOT NULL DEFAULT '#c8a86b',
  font_family    VARCHAR(20) NOT NULL DEFAULT 'professional'
                               CHECK (font_family IN ('professional','modern','executive','bold')),
  cover_style    VARCHAR(10) NOT NULL DEFAULT 'classic'
                               CHECK (cover_style IN ('classic','modern','bold','minimal')),
  report_footer_text TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_profiles_company_unique UNIQUE (company_id)
);

CREATE INDEX IF NOT EXISTS brand_profiles_company_id_idx ON brand_profiles(company_id);
