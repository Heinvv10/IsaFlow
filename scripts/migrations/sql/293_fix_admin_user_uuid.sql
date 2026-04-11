-- 293: Fix admin user ID to be a valid UUID
-- The admin user was seeded with id='admin-001' (non-UUID varchar).
-- Tables like customer_payments.created_by are UUID typed and reject 'admin-001'.
-- This migration promotes admin to a proper UUID.

DO $$
DECLARE
  v_old_id    TEXT := 'admin-001';
  v_new_id    TEXT := '00000000-0000-0000-0000-000000000099';
  v_old_email TEXT;
BEGIN
  -- Skip if old user no longer exists
  IF NOT EXISTS(SELECT 1 FROM users WHERE id = v_old_id) THEN
    RAISE NOTICE 'Admin-001 not found — migration already applied or not needed.';
    RETURN;
  END IF;

  -- Skip if new UUID already taken
  IF EXISTS(SELECT 1 FROM users WHERE id = v_new_id) THEN
    RAISE NOTICE 'Target UUID already exists — skipping.';
    RETURN;
  END IF;

  SELECT email INTO v_old_email FROM users WHERE id = v_old_id;

  -- Step 1: Insert shadow row with UUID and temp email (avoid unique constraint)
  INSERT INTO users (id, email, password_hash, first_name, last_name, role,
                     permissions, is_active, created_at, updated_at)
  SELECT v_new_id,
         email || '__migrating',
         password_hash, first_name, last_name, role,
         permissions, is_active, created_at, updated_at
  FROM users WHERE id = v_old_id;

  -- Step 2: Re-point all VARCHAR FK references to the new UUID
  UPDATE user_sessions    SET user_id    = v_new_id WHERE user_id    = v_old_id;
  UPDATE company_users    SET user_id    = v_new_id WHERE user_id    = v_old_id;
  UPDATE user_permissions SET user_id    = v_new_id WHERE user_id    = v_old_id;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_preferences'        AND table_schema = 'public') THEN
    EXECUTE format('UPDATE user_preferences SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_invitations'     AND table_schema = 'public') THEN
    EXECUTE format('UPDATE company_invitations SET invited_by = %L WHERE invited_by = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_log'               AND table_schema = 'public') THEN
    EXECUTE format('UPDATE audit_log SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_2fa'                AND table_schema = 'public') THEN
    EXECUTE format('UPDATE user_2fa SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_trusted_devices'    AND table_schema = 'public') THEN
    EXECUTE format('UPDATE user_trusted_devices SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_granular_permissions' AND table_schema = 'public') THEN
    EXECUTE format('UPDATE user_granular_permissions SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'custom_reports'          AND table_schema = 'public') THEN
    EXECUTE format('UPDATE custom_reports SET created_by = %L WHERE created_by = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'disclosure_notes'        AND table_schema = 'public') THEN
    EXECUTE format('UPDATE disclosure_notes SET created_by = %L WHERE created_by = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'archive_runs'            AND table_schema = 'public') THEN
    EXECUTE format('UPDATE archive_runs SET run_by = %L WHERE run_by = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'page_visits'             AND table_schema = 'public') THEN
    EXECUTE format('UPDATE page_visits SET user_id = %L WHERE user_id = %L', v_new_id, v_old_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'recurring_templates'     AND table_schema = 'public') THEN
    EXECUTE format('UPDATE recurring_templates SET created_by = %L WHERE created_by = %L', v_new_id, v_old_id);
  END IF;

  -- Step 3: Delete old user (FK refs already re-pointed; no cascade will fire)
  DELETE FROM users WHERE id = v_old_id;

  -- Step 4: Restore real email
  UPDATE users SET email = v_old_email WHERE id = v_new_id;

  RAISE NOTICE 'Admin migrated: % -> % (email: %)', v_old_id, v_new_id, v_old_email;
END;
$$;
