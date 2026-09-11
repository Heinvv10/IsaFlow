-- The company authority key ('control-authority:' || company) is taken EXCLUSIVELY by every function that resolves or
-- checks what a person may do, so it serialises every permission-checked transaction in a company from its first
-- check to COMMIT. Nothing bounded the wait: a transaction that held it for minutes (the audit worker did, for its
-- whole work transaction) pinned every request connection of that company with no timeout.
--
-- Here every function that takes the key waits at most 5 s for any lock (lock_timeout; 55P03 answers 503 +
-- Retry-After at the request edge). The key stays exclusive and the bodies are unchanged. Any other function naming
-- the key must be classified by hand before this runs again.
DO $$
DECLARE
  holders regprocedure[] := ARRAY[
    'public.control_lock_permission_principal(uuid,text)',
    'public.control_approval_authorities(uuid,uuid)',
    'public.control_beneficiary_authorities(uuid,uuid)',
    'public.control_exception_owner(uuid,text)'
  ]::regprocedure[];
  fn regprocedure;
  unclassified text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO unclassified FROM pg_proc p
    WHERE p.prosrc LIKE '%control-authority:%' AND p.oid <> ALL(holders::oid[]);
  IF unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'Unclassified control-authority lock holder(s): %', unclassified;
  END IF;
  FOREACH fn IN ARRAY holders LOOP
    EXECUTE format('ALTER FUNCTION %s SET lock_timeout = %L', fn, '5s');
  END LOOP;
END $$;
