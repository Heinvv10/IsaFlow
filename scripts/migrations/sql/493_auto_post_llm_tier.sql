-- 493_auto_post_llm_tier.sql
-- LLM auto-post tier: separate stricter gate + persisted suggestion strategy.

ALTER TABLE bank_auto_post_settings
  ADD COLUMN IF NOT EXISTS llm_enabled        BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS llm_min_confidence NUMERIC(3,2)  NOT NULL DEFAULT 0.95,
  ADD COLUMN IF NOT EXISTS llm_amount_cap     NUMERIC(14,2) NOT NULL DEFAULT 2000;  -- 0 = no cap

-- Persisted match source for each suggestion: 'rule' | 'pattern' | 'historical' | 'llm'.
-- NULL = no suggestion yet. The auto-post gate reads this to pick the tier.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS suggested_strategy TEXT;
