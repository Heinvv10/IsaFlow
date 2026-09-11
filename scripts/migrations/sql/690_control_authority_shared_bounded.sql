-- The company authority key ('control-authority:' || company) is taken only by READERS: functions that resolve or
-- check what a person may do. No writer takes it; what stops an authority change landing between a check and the
-- action it authorises is the row locks those readers hold to COMMIT (FOR UPDATE on the person's company_users and
-- users rows, which also blocks a new override's foreign-key check; FOR SHARE on company_user_permissions, the
-- PAT/OAuth grant and the company). Taken exclusively, the key serialised every permission check in a company behind
-- every other, and behind any long holder, with no bound.
--
-- Here every reader takes the key SHARED, so readers no longer queue behind each other, and every function that takes
-- it waits at most 5 s for any lock (lock_timeout, 55P03, answered as 503 + Retry-After at the request edge).
--
-- The bodies are rewritten in place from their live definitions rather than restated, so a body another migration
-- has since changed is kept. Any other function naming the key must be classified by hand before this runs again.
DO $$
DECLARE
  readers regprocedure[] := ARRAY[
    'public.control_lock_permission_principal(uuid,text)',
    'public.control_approval_authorities(uuid,uuid)',
    'public.control_beneficiary_authorities(uuid,uuid)',
    'public.control_exception_owner(uuid,text)'
  ]::regprocedure[];
  fn regprocedure;
  unclassified text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO unclassified FROM pg_proc p
    WHERE p.prosrc LIKE '%control-authority:%' AND p.oid <> ALL(readers::oid[]);
  IF unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'Unclassified control-authority lock holder(s): %', unclassified;
  END IF;
  FOREACH fn IN ARRAY readers LOOP
    EXECUTE replace(pg_get_functiondef(fn),
      'pg_advisory_xact_lock(hashtextextended(''control-authority:''',
      'pg_advisory_xact_lock_shared(hashtextextended(''control-authority:''');
    EXECUTE format('ALTER FUNCTION %s SET lock_timeout = %L', fn, '5s');
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(''control-authority:%') THEN
    RAISE EXCEPTION 'An exclusive control-authority lock survived';
  END IF;
END $$;
