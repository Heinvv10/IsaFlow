-- 527: unique names within the practice job taxonomy.
--
-- create_job_category / create_work_item (REST and MCP) check for a duplicate
-- name by SELECTing first and then INSERTing. With no constraint behind it that
-- is read-then-write: two concurrent calls both see "no clash" before either
-- INSERT lands, and the practice ends up with two identically-named categories.
-- Nothing then errors — the split only shows up later as two half-populated
-- rows in every service-mix and utilisation report, which is exactly what the
-- check was written to prevent.
--
-- Case- and whitespace-insensitive, because "VAT", "vat" and "VAT " are the
-- same category to the person reading the report.
--
-- Scope note: categories are unique per COMPANY; work items only per CATEGORY,
-- so two categories may each legitimately hold a "Review" or "Admin" item.
--
-- Verified before writing: zero violating groups in either isaflow or
-- isaflow_dev, so both indexes build without a cleanup pass.

CREATE UNIQUE INDEX IF NOT EXISTS uq_practice_job_categories_company_name
  ON practice_job_categories (company_id, lower(btrim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_practice_work_items_category_name
  ON practice_work_items (company_id, category_id, lower(btrim(name)));
