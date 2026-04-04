-- 287: Page visit tracking for usage-based quick actions
CREATE TABLE IF NOT EXISTS page_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  last_visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id, page_path)
);

CREATE INDEX IF NOT EXISTS idx_page_visits_user_company
  ON page_visits(user_id, company_id, visit_count DESC);
