-- 931: shared_merchant_patterns — the cross-company merchant -> category pool, its only writer and its only
-- reader (learning loop PR 2; Hein's decisions 2026-10-21, decisions 4, 6 and 7). SECURITY REVIEW ITEM:
-- docs/security/shared-merchant-patterns.md is the threat model.
--
-- 1. The table holds ONE row per normalised merchant: the winning category and counts. Nothing else.
--    No company_id, bureau_id, user id, transaction id, amount, raw description, account name or id, and
--    no back-reference of any kind; tests/unit/sharedPool/sharedPoolTableGuard.test.ts refuses any such
--    column. Its CHECKs are the publication rule itself, so no writer can store a row that breaks it:
--      distinct_company_count >= 5   MIN_DISTINCT_COMPANIES (Hein chose 5; the research report suggested
--                                    k >= 10 — the doc records the trade-off)
--      agreement_pct >= 0.8          MIN_AGREEMENT: the share of those companies whose own majority
--                                    category is the winner
--      normalized_merchant           the PII filter's output shape only: one or two A-Z words
--    merchantPool.ts holds both constants and pins them to these CHECKs (merchantPool.test.ts reads this file).
--
-- 2. Access: deny-all, 904's pattern for bureau_audit_log. ENABLE + FORCE RLS with NO policy, and every
--    non-owner role (app_user, platform_admin, migration_admin, PUBLIC) holds no privilege on it. The owner
--    reaches it only through the two functions below; rls-policy-coverage checks only company_id tables,
--    so the unit guard and tests/integration/shared-merchant-patterns.int.test.ts pin the deny-all.
--
-- 3. shared_pool_publish(rows jsonb, filter_version int) — the ONLY writer. SECURITY DEFINER, EXECUTE for
--    migration_admin only (the pool login inherits it; app_user and platform_admin cannot call it). The
--    aggregation job (sharedPoolJob.ts + merchantPool.ts) does the work in TS because the PII filter is TS and must
--    run before anything is counted; it then hands the publishable rows here. The function replaces the
--    whole table in one statement (full recompute: a bureau that opts out loses its clients' votes on the
--    next run), refuses any element key other than the five it stores (so a caller cannot slip a company
--    id in), lets the CHECKs refuse anything under the thresholds, and refuses a non-poolable category.
--    EXCLUSIVE lock: two runs serialise; readers (ACCESS SHARE) are not blocked and see the old pool until
--    COMMIT.
--
-- 4. shared_pool_lookup(company_id uuid, merchants text[]) — the ONLY reader. SECURITY DEFINER, EXECUTE for
--    app_user. Returns (merchant, category_code, confidence) for the exact keys asked, at most 500 per
--    call — never a scan or a pattern match, so it cannot dump the pool. It answers nothing unless the
--    company is the caller's ACTIVE company (app.current_company_id()), a company the caller belongs to
--    (auth.user_companies()), and pool-eligible (decision 3: linked to at least one bureau, and every
--    linked bureau has share_merchant_patterns). Confidence = min(0.80, agreement x (0.5 + 0.5 x
--    min(1, companies / 10))): 5 companies at 80% -> 0.60, the floor a cold-start suggestion needs; it
--    never reaches the HIGH band (0.85) and the auto-post gate refuses shared_pool outright anyway.
--
-- 5. Numbered 931, after 930 (was 906, never applied anywhere). 930 refuses any SECURITY DEFINER function
--    missing from public.app_definer_reviews, so the migration that creates a definer must review and list
--    it; 906 ran before 930 created that registry and every deploy would have stopped at 930. The two
--    rows are inserted at the end, with 930's app_definer_hash(), and 930's whole rule set is re-checked.
--
-- Both functions: search_path pinned with pg_temp last; owner must bypass RLS (it reads a FORCE RLS
-- table); grants enumerated and asserted below (885 / 888's recipe).
--
-- Rollback (nothing else references these objects):
--   DROP FUNCTION IF EXISTS public.shared_pool_lookup(pg_catalog.uuid, pg_catalog.text[]);
--   DROP FUNCTION IF EXISTS public.shared_pool_publish(pg_catalog.jsonb, pg_catalog.int4);
--   DROP TABLE IF EXISTS public.shared_merchant_patterns;
-- Locks: one new table; brief SHARE ROW EXCLUSIVE on merchant_categories for the FK.

CREATE TABLE IF NOT EXISTS shared_merchant_patterns (
  normalized_merchant    TEXT PRIMARY KEY CHECK (normalized_merchant ~ '^[A-Z]{2,40}( [A-Z]{2,40})?$'),
  category_code          TEXT NOT NULL REFERENCES merchant_categories(code),
  distinct_company_count INTEGER NOT NULL CHECK (distinct_company_count >= 5),
  agreement_pct          NUMERIC(5,4) NOT NULL CHECK (agreement_pct >= 0.8 AND agreement_pct <= 1),
  total_observations     INTEGER NOT NULL CHECK (total_observations >= distinct_company_count),
  filter_version         INTEGER NOT NULL CHECK (filter_version >= 1),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shared_merchant_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_merchant_patterns FORCE ROW LEVEL SECURITY;

DO $$
DECLARE r RECORD; p RECORD;
BEGIN
  FOR p IN SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'shared_merchant_patterns' LOOP
    EXECUTE pg_catalog.format('DROP POLICY %I ON public.shared_merchant_patterns', p.policyname);
  END LOOP;
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'shared_merchant_patterns'
      AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                      WHERE c.oid = 'public.shared_merchant_patterns'::pg_catalog.regclass)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.shared_merchant_patterns FROM %I', r.grantee);
  END LOOP;
  REVOKE ALL ON public.shared_merchant_patterns FROM PUBLIC;
END $$;

CREATE OR REPLACE FUNCTION public.shared_pool_publish(p_rows pg_catalog.jsonb, p_filter_version pg_catalog.int4)
RETURNS pg_catalog.int4
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count pg_catalog.int4;
BEGIN
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'shared_pool_publish: rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) e
    WHERE pg_catalog.jsonb_typeof(e) <> 'object'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(e) k
                  WHERE k NOT IN ('merchant', 'category', 'companies', 'agreement', 'observations'))
  ) THEN
    RAISE EXCEPTION 'shared_pool_publish: an element carries a field the pool does not store' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) e
    JOIN public.merchant_categories c ON c.code = e->>'category'
    WHERE NOT c.poolable
  ) THEN
    RAISE EXCEPTION 'shared_pool_publish: a non-poolable category was offered' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.shared_merchant_patterns IN EXCLUSIVE MODE;
  DELETE FROM public.shared_merchant_patterns;
  INSERT INTO public.shared_merchant_patterns
    (normalized_merchant, category_code, distinct_company_count, agreement_pct, total_observations, filter_version)
  SELECT e->>'merchant', e->>'category', (e->>'companies')::pg_catalog.int4,
         (e->>'agreement')::pg_catalog.numeric, (e->>'observations')::pg_catalog.int4, p_filter_version
  FROM pg_catalog.jsonb_array_elements(p_rows) e;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION public.shared_pool_lookup(p_company_id pg_catalog.uuid, p_merchants pg_catalog.text[])
RETURNS TABLE (merchant pg_catalog.text, category_code pg_catalog.text, confidence pg_catalog.numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_merchants IS NULL OR pg_catalog.cardinality(p_merchants) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_merchants) > 500 THEN
    RAISE EXCEPTION 'shared_pool_lookup: at most 500 merchants per call' USING ERRCODE = '22023';
  END IF;
  -- The caller's active company, which the caller belongs to.
  IF p_company_id IS NULL OR p_company_id IS DISTINCT FROM app.current_company_id()
     OR NOT EXISTS (SELECT 1 FROM auth.user_companies() uc WHERE uc = p_company_id) THEN
    RETURN;
  END IF;
  -- Pool-eligible (decision 3): at least one bureau, and every linked bureau opted in.
  IF NOT EXISTS (SELECT 1 FROM public.bureau_companies bc WHERE bc.company_id = p_company_id)
     OR EXISTS (SELECT 1 FROM public.bureau_companies bc JOIN public.bureaus b ON b.id = bc.bureau_id
                WHERE bc.company_id = p_company_id AND NOT b.share_merchant_patterns) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT p.normalized_merchant, p.category_code,
           pg_catalog.round(LEAST(0.80, p.agreement_pct
             * (0.5 + 0.5 * LEAST(1.0, p.distinct_company_count::pg_catalog.numeric / 10.0))), 4)
    FROM public.shared_merchant_patterns p
    WHERE p.normalized_merchant = ANY (p_merchants);
END
$$;

-- Privileges: every grantee enumerated and revoked, then exactly one role back per function.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS fn, pg_catalog.pg_get_userbyid(a.grantee) AS grantee
    FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = ANY (ARRAY['public.shared_pool_publish(pg_catalog.jsonb,pg_catalog.int4)',
                             'public.shared_pool_lookup(pg_catalog.uuid,pg_catalog.text[])']::pg_catalog.regprocedure[]::pg_catalog.oid[])
      AND a.grantee <> p.proowner AND a.grantee <> 0
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, r.grantee);
  END LOOP;
  REVOKE ALL ON FUNCTION public.shared_pool_publish(pg_catalog.jsonb, pg_catalog.int4) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.shared_pool_lookup(pg_catalog.uuid, pg_catalog.text[]) FROM PUBLIC;
END $$;
GRANT EXECUTE ON FUNCTION public.shared_pool_publish(pg_catalog.jsonb, pg_catalog.int4) TO migration_admin;
GRANT EXECUTE ON FUNCTION public.shared_pool_lookup(pg_catalog.uuid, pg_catalog.text[]) TO app_user;

-- Assertions: refuse to ship it any other way. The exemption is 872's (#680): only the role RUNNING this
-- migration, when it inherits the owner (the deploy role on production, a member of migration_admin).
DO $$
DECLARE
  v_owner pg_catalog.oid := (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.shared_merchant_patterns'::pg_catalog.regclass);
  v_publish pg_catalog.text := 'public.shared_pool_publish(pg_catalog.jsonb,pg_catalog.int4)';
  v_lookup pg_catalog.text := 'public.shared_pool_lookup(pg_catalog.uuid,pg_catalog.text[])';
  v_fn pg_catalog.text;
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_catalog.pg_class c
          WHERE c.oid = 'public.shared_merchant_patterns'::pg_catalog.regclass)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'shared_merchant_patterns') THEN
    RAISE EXCEPTION 'migration 931: shared_merchant_patterns must be under FORCE RLS with no policy';
  END IF;
  FOR v_role IN
    SELECT rr.rolname FROM pg_catalog.pg_roles rr
    WHERE NOT rr.rolsuper AND rr.oid <> v_owner AND rr.rolname !~ '^pg_'
      AND NOT (rr.rolname = session_user AND pg_catalog.pg_has_role(rr.oid, v_owner, 'USAGE'))
    UNION ALL SELECT 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.shared_merchant_patterns', v_priv) THEN
        RAISE EXCEPTION 'migration 931: % still holds % on shared_merchant_patterns', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[v_publish, v_lookup] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
      WHERE p.oid = v_fn::pg_catalog.regprocedure AND p.prosecdef AND (o.rolbypassrls OR o.rolsuper)
    ) THEN
      RAISE EXCEPTION 'migration 931: % must be SECURITY DEFINER with an owner that bypasses RLS', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_fn::pg_catalog.regprocedure
        AND p.proconfig[pg_catalog.array_upper(p.proconfig, 1)] ~ '^search_path=.*pg_temp$'
    ) THEN
      RAISE EXCEPTION 'migration 931: % must pin search_path with pg_temp last', v_fn;
    END IF;
    IF pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 931: PUBLIC may execute %', v_fn;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege('app_user', v_lookup, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 931: app_user must be able to execute %', v_lookup;
  END IF;
  -- Only the owner and migration_admin (and the role running this, when it inherits either) may publish.
  FOR v_role IN
    SELECT rr.rolname FROM pg_catalog.pg_proc p
    CROSS JOIN (SELECT rolname, oid FROM pg_catalog.pg_roles WHERE NOT rolsuper AND rolname !~ '^pg_') rr
    WHERE p.oid = v_publish::pg_catalog.regprocedure AND rr.oid <> p.proowner AND rr.rolname <> 'migration_admin'
      AND NOT pg_catalog.pg_has_role(rr.oid, 'migration_admin', 'USAGE')
      AND NOT pg_catalog.pg_has_role(rr.oid, p.proowner, 'USAGE')
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_publish, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 931: % may still execute %', v_role, v_publish;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('app_user', v_publish, 'EXECUTE')
     OR pg_catalog.has_function_privilege('platform_admin', v_publish, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 931: app_user / platform_admin may execute %', v_publish;
  END IF;
END $$;

-- 930's definer registry: what each definer writes, hashed over its full definition and owner.
INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(p.oid)
  FROM (VALUES
    ('shared_pool_publish(jsonb,integer)',
     'shared_merchant_patterns only (full replace); migration_admin only; refuses any field but the five it stores'),
    ('shared_pool_lookup(uuid,text[])',
     'nothing (read): exact merchant keys, at most 500, for the caller''s active, pool-eligible company')) v(signature, writes)
  JOIN pg_catalog.pg_proc p ON p.oid::pg_catalog.regprocedure::pg_catalog.text = v.signature
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
DECLARE
  v pg_catalog.text;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.app_definer_reviews
       WHERE signature IN ('shared_pool_publish(jsonb,integer)', 'shared_pool_lookup(uuid,text[])')) <> 2 THEN
    RAISE EXCEPTION 'migration 931: both shared-pool definers must be listed in app_definer_reviews';
  END IF;
  FOR v IN SELECT * FROM public.app_pool_reach_violations() ORDER BY 1 LOOP
    RAISE EXCEPTION '931: %', v;
  END LOOP;
END $$;

COMMENT ON TABLE shared_merchant_patterns IS
  'Shared merchant-pattern pool: normalised merchant -> winning ISAFlow category, published only at >= 5 eligible companies and >= 80% agreement. No tenant, user, transaction or amount data. Deny-all; written only by shared_pool_publish, read only by shared_pool_lookup. SECURITY REVIEW ITEM: docs/security/shared-merchant-patterns.md.';
