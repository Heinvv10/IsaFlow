-- Migration 1010b: only an owner or admin writes per-module permissions (#1656, review of #1670).
--
-- company_user_permissions is what supplier-invoice, credit-note, purchase-order,
-- payment-batch and approval-request approval now enforce (checkPermission). Its
-- RLS policy (tenant_isolation, 270/348) lets ANY member of the company insert,
-- update or delete rows, so a manager whose Approve was unticked could tick it
-- back with one statement. The routes already allow owner/admin only
-- (pages/api/accounting/permissions.ts); this makes the database refuse the rest.
--
-- Bound: app_user, and any role holding app_service that is neither a superuser
-- nor BYPASSRLS (916's rule: isaflow_service inherits app_user's rules). Those
-- writers must be an owner or admin of the row's company (old and new company
-- on an UPDATE), judged by company_member_actor_role (auth.uid() from the
-- request's claims). Not bound: platform_admin (the admin portal's permissions
-- route), migration_admin and the deploy role. Refusal: 42501.

CREATE OR REPLACE FUNCTION public.company_user_permissions_write_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_bound pg_catalog.bool := current_user = 'app_user'
    OR (pg_catalog.pg_has_role(current_user, 'app_service', 'USAGE')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
                        WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)));
BEGIN
  IF v_bound THEN
    IF TG_OP <> 'INSERT'
       AND COALESCE(public.company_member_actor_role(OLD.company_id) IN ('owner', 'admin'), false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Only owners and admins can change module permissions' USING ERRCODE = '42501';
    END IF;
    IF TG_OP <> 'DELETE'
       AND COALESCE(public.company_member_actor_role(NEW.company_id) IN ('owner', 'admin'), false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Only owners and admins can change module permissions' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE ALL ON FUNCTION public.company_user_permissions_write_guard() FROM PUBLIC;
-- Review of #1670 (N4): owned by migration_admin, as 1000 / 1002 / 1006 / 1012 own theirs.
ALTER FUNCTION public.company_user_permissions_write_guard() OWNER TO migration_admin;

CREATE OR REPLACE TRIGGER company_user_permissions_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.company_user_permissions_write_guard();
