-- 340_afs_section_comments.sql
-- Per-section threaded comments with resolution tracking for the review workflow.

CREATE TABLE IF NOT EXISTS afs_section_comments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id    UUID        NOT NULL REFERENCES afs_sections(id) ON DELETE CASCADE,
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_id     TEXT        NOT NULL REFERENCES users(id),
  body          TEXT        NOT NULL,
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by   TEXT        REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  parent_id     UUID        REFERENCES afs_section_comments(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_section
  ON afs_section_comments(section_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_company
  ON afs_section_comments(company_id);

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_parent
  ON afs_section_comments(parent_id);
