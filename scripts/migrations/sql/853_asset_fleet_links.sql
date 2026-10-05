-- 853_asset_fleet_links.sql
-- Fleet records for vehicles held as fixed assets, and asset / fleet LINKS on
-- bank lines (Hein, 2026-10-05).
--
-- A vehicle is an `assets` row: fuel fills and services hang off it by
-- asset_id. There is no separate vehicle table.
--
-- A link is an ANNOTATION on the bank line only. It never changes the line's
-- status, journal link or reconciliation stamp, and posts nothing (D12: link
-- ids are outside "a completed reconciliation is immutable"). An asset has
-- many bank lines, so the link lives on bank_transactions; assets and the
-- fleet tables carry no bank column.
--
-- Same-company guarantee in the database, not only in the service:
--   · a fleet record's asset is a composite FK (asset_id, company_id) ->
--     assets (id, company_id), so a record cannot name another company's asset;
--   · each link column is a composite FK (<link>, company_id) -> the target's
--     (id, company_id), so a bank line cannot name another company's record.
--     ON DELETE SET NULL (<link column>) clears only the link (PG 15+), never
--     the line's company_id.
-- The UNIQUE (id, company_id) keys exist only to be FK targets; id alone is
-- already the primary key, so they refuse nothing.
--
-- At most one of the three link columns is set (CHECK).
--
-- A fleet record's asset FK is ON DELETE CASCADE, so deleting an asset would
-- take its fuel / service records with it and (SET NULL) clear the bank links
-- to them — the outcome the record delete refuses (409). No path deletes an
-- `assets` row today (census 2026-10-05: no DELETE FROM assets in src/, pages/,
-- scripts/ or any database function; company delete is a soft status flip;
-- the soft-delete purge covers customers, suppliers, items, bank rules and
-- invoices only). CASCADE is kept so the fleet rows never block a future
-- whole-company purge; a per-asset delete, if one is ever added, must refuse
-- an asset whose records a bank line links to.
--
-- Every DDL here takes a strong lock on assets / bank_transactions; queued
-- behind a long transaction it would block every bank read, so fail instead
-- (as 649, 717, 718, 851). The lock_timeout bounds the wait to ACQUIRE a lock,
-- not the work done under it: see the constraint block below.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_id_company_key' AND conrelid = 'assets'::regclass
  ) THEN
    ALTER TABLE assets ADD CONSTRAINT assets_id_company_key UNIQUE (id, company_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fleet_fuel_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  asset_id UUID NOT NULL,
  fill_date DATE NOT NULL,
  litres NUMERIC(10,2) NOT NULL CHECK (litres > 0),
  amount NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  odometer_km INTEGER CHECK (odometer_km >= 0),
  supplier_name TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_fuel_transactions_id_company_key UNIQUE (id, company_id),
  CONSTRAINT fleet_fuel_transactions_asset_fkey FOREIGN KEY (asset_id, company_id)
    REFERENCES assets (id, company_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fleet_service_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  asset_id UUID NOT NULL,
  service_date DATE NOT NULL,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  amount NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  odometer_km INTEGER CHECK (odometer_km >= 0),
  supplier_name TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_service_history_id_company_key UNIQUE (id, company_id),
  CONSTRAINT fleet_service_history_asset_fkey FOREIGN KEY (asset_id, company_id)
    REFERENCES assets (id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fleet_fuel_transactions_asset_date
  ON fleet_fuel_transactions (company_id, asset_id, fill_date);
CREATE INDEX IF NOT EXISTS idx_fleet_service_history_asset_date
  ON fleet_service_history (company_id, asset_id, service_date);

-- Tenant RLS, as 699: enabled and forced BEFORE the grant; membership to read,
-- membership AND the active company to write.
ALTER TABLE fleet_fuel_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_fuel_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE fleet_service_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_service_history FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_fuel_transactions TO app_user, platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_service_history TO app_user, platform_admin;
GRANT ALL ON fleet_fuel_transactions TO migration_admin;
GRANT ALL ON fleet_service_history TO migration_admin;

DROP POLICY IF EXISTS tenant_isolation ON fleet_fuel_transactions;
CREATE POLICY tenant_isolation ON fleet_fuel_transactions
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());

DROP POLICY IF EXISTS tenant_isolation ON fleet_service_history;
CREATE POLICY tenant_isolation ON fleet_service_history
  FOR ALL TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_companies()) AND company_id = app.current_company_id());

-- The links. Adding each FK and the CHECK scans bank_transactions once under
-- SHARE ROW EXCLUSIVE (writes blocked, reads not), bounded by the table's size;
-- every row is NULL in the new columns, so each scan finds nothing to refuse.
-- NOT VALID + VALIDATE would gain nothing here: in one transaction the ALTER's
-- stronger lock is held to commit anyway. Deployed after hours.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS linked_asset_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS linked_fleet_fuel_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS linked_fleet_service_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_linked_asset_fkey'
      AND conrelid = 'bank_transactions'::regclass
  ) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_linked_asset_fkey
      FOREIGN KEY (linked_asset_id, company_id) REFERENCES assets (id, company_id)
      ON DELETE SET NULL (linked_asset_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_linked_fleet_fuel_fkey'
      AND conrelid = 'bank_transactions'::regclass
  ) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_linked_fleet_fuel_fkey
      FOREIGN KEY (linked_fleet_fuel_id, company_id) REFERENCES fleet_fuel_transactions (id, company_id)
      ON DELETE SET NULL (linked_fleet_fuel_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_linked_fleet_service_fkey'
      AND conrelid = 'bank_transactions'::regclass
  ) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_linked_fleet_service_fkey
      FOREIGN KEY (linked_fleet_service_id, company_id) REFERENCES fleet_service_history (id, company_id)
      ON DELETE SET NULL (linked_fleet_service_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_one_asset_link_chk'
      AND conrelid = 'bank_transactions'::regclass
  ) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_one_asset_link_chk
      CHECK (num_nonnulls(linked_asset_id, linked_fleet_fuel_id, linked_fleet_service_id) <= 1);
  END IF;
END $$;

-- The FK actions look a target up by the link column alone; the asset page reads by it.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_linked_asset
  ON bank_transactions (linked_asset_id) WHERE linked_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_linked_fleet_fuel
  ON bank_transactions (linked_fleet_fuel_id) WHERE linked_fleet_fuel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_linked_fleet_service
  ON bank_transactions (linked_fleet_service_id) WHERE linked_fleet_service_id IS NOT NULL;
