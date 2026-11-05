-- 959: the company's default payment terms get a change history (Hein, 2026-11-05: who, when, old -> new).
--
-- The default lives in accounting_settings (key 'default_payment_terms', JSON), not on companies (936 made companies
-- column-level read-only for the app pools), so 888's company projection cannot see it. It is tracked as its own entity
-- type, `company_setting`, with the same capture: owner / admin read it (entity_changes_read's ELSE arm, unchanged),
-- the actor, the channel and the before / after are recorded by the database whoever writes it.
--
-- Only THIS key is tracked: accounting_settings also holds noisy keys (budget alert run markers), and the generic
-- /accounting-settings route can write any key. Three narrow triggers (INSERT / UPDATE / DELETE: a WHEN clause may name
-- OLD only for an UPDATE or DELETE), each ENABLE ALWAYS as 888's. The capture function and the projection are
-- UNCHANGED (the projection keeps every column but id, created_at and updated_at: company_id, key, value), so 930's
-- definer registry is too.
--
-- Expand-only and safe beside the old code: the old code never writes this key, and a write to any other key fires no
-- trigger. A rollback of code alone leaves a harmless trigger.
--
-- Lock: the entity_type CHECK is replaced NOT VALID then validated, so entity_changes takes ACCESS EXCLUSIVE only for
-- the catalogue change, not for a scan. A lock not granted within 5s aborts the migration, which has then changed nothing.

SET LOCAL lock_timeout = '5s';

ALTER TABLE entity_changes DROP CONSTRAINT IF EXISTS entity_changes_entity_type_check;
ALTER TABLE entity_changes ADD CONSTRAINT entity_changes_entity_type_check CHECK (entity_type IN (
  'supplier', 'customer', 'gl_account', 'payroll_employee', 'company_user', 'company_invitation',
  'company_user_permission', 'company', 'approval_rule', 'approval_enforcement', 'payroll_bank_detail',
  'company_setting')) NOT VALID;
ALTER TABLE entity_changes VALIDATE CONSTRAINT entity_changes_entity_type_check;

DROP TRIGGER IF EXISTS entity_change_capture_ins ON accounting_settings;
CREATE TRIGGER entity_change_capture_ins AFTER INSERT ON accounting_settings
  FOR EACH ROW WHEN (NEW.key = 'default_payment_terms')
  EXECUTE FUNCTION public.entity_change_capture('company_setting');
DROP TRIGGER IF EXISTS entity_change_capture_upd ON accounting_settings;
CREATE TRIGGER entity_change_capture_upd AFTER UPDATE ON accounting_settings
  FOR EACH ROW WHEN (OLD.key = 'default_payment_terms' OR NEW.key = 'default_payment_terms')
  EXECUTE FUNCTION public.entity_change_capture('company_setting');
DROP TRIGGER IF EXISTS entity_change_capture_del ON accounting_settings;
CREATE TRIGGER entity_change_capture_del AFTER DELETE ON accounting_settings
  FOR EACH ROW WHEN (OLD.key = 'default_payment_terms')
  EXECUTE FUNCTION public.entity_change_capture('company_setting');
ALTER TABLE accounting_settings ENABLE ALWAYS TRIGGER entity_change_capture_ins;
ALTER TABLE accounting_settings ENABLE ALWAYS TRIGGER entity_change_capture_upd;
ALTER TABLE accounting_settings ENABLE ALWAYS TRIGGER entity_change_capture_del;
