-- Migration 303: Item Bundles (composite items)
-- Adds is_bundle flag to items and a bundle lines table

ALTER TABLE items ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS item_bundle_lines (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_item_id UUID        NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  child_item_id  UUID        NOT NULL REFERENCES items(id),
  quantity       NUMERIC(15,4) NOT NULL DEFAULT 1,
  sort_order     INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(parent_item_id, child_item_id)
);

CREATE INDEX IF NOT EXISTS idx_item_bundle_lines_parent
  ON item_bundle_lines(company_id, parent_item_id);
