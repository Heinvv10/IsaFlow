-- 335_note_templates.sql
-- Vendor-maintained template registry for all 30+ IFRS note types.

CREATE TABLE IF NOT EXISTS note_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_type       TEXT NOT NULL,
  framework          TEXT NOT NULL CHECK (framework IN ('ifrs_smes', 'full_ifrs', 'both')),
  title              TEXT NOT NULL,
  data_queries       JSONB NOT NULL DEFAULT '{}'::JSONB,
  content_schema     JSONB NOT NULL DEFAULT '{}'::JSONB,
  ai_prompt_template TEXT,
  is_mandatory       BOOLEAN NOT NULL DEFAULT TRUE,
  standard_reference TEXT,
  effective_from     DATE NOT NULL DEFAULT CURRENT_DATE,
  supersedes         UUID REFERENCES note_templates(id),
  change_summary     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_templates_section_type
  ON note_templates(section_type);

CREATE INDEX IF NOT EXISTS idx_note_templates_framework
  ON note_templates(framework);

CREATE INDEX IF NOT EXISTS idx_note_templates_effective_from
  ON note_templates(effective_from DESC);

-- Unique index needed for ON CONFLICT upsert in noteTemplateRegistry seed function
CREATE UNIQUE INDEX IF NOT EXISTS uq_note_templates_section_framework
  ON note_templates(section_type, framework);
