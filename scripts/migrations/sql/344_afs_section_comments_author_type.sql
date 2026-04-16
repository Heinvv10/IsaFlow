-- Migration 344: Add author_type to distinguish staff vs portal comments

ALTER TABLE afs_section_comments
  ADD COLUMN IF NOT EXISTS author_type TEXT NOT NULL DEFAULT 'staff'
  CHECK (author_type IN ('staff', 'portal'));

CREATE INDEX IF NOT EXISTS idx_afs_section_comments_author_type
  ON afs_section_comments(section_id, author_type);
