/**
 * Migration 1058 (MCP connector default-on for new companies, owner/admin self-serve toggle): the file's shape.
 *
 * Text only: the SQL itself runs first on GitHub's integration gate
 * (tests/integration/mcp-connector-default-on.migration.int.test.ts). These pins stop the shapes the review
 * depends on from drifting: create_company_with_owner is 513 plus one line, the default-on function cannot
 * overwrite or backfill, the toggle is the only app_user surface and keeps the platform lock, no backfill.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'scripts/migrations/sql');
const MIGRATION = readFileSync(path.join(dir, '1058_mcp_connector_default_on_self_serve.sql'), 'utf8');
const M513 = readFileSync(path.join(dir, '513_create_company_writes_vat_system_type.sql'), 'utf8');

function body(src: string, fn: string): string {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const end = src.indexOf('\n$$;', start);
  expect(end, fn).toBeGreaterThan(start);
  return src.slice(start, end);
}
const stripComments = (s: string): string =>
  s.split('\n').map((l) => l.replace(/--.*$/, '').trimEnd()).filter((l) => l.trim() !== '').join('\n');

/** The file with every function body ($$ ... $$) and the registry insert removed, comments stripped. */
function topLevel(): string {
  let s = stripComments(MIGRATION).replace(/\$\$[\s\S]*?\$\$/g, '$$ $$');
  s = s.replace(/INSERT INTO public\.app_definer_reviews[\s\S]*?;/g, '');
  return s;
}

const PERFORM_LINE = 'PERFORM public.enable_mcp_connector_default(new_row.id, caller_id::uuid);';

describe('1058: create_company_with_owner', () => {
  it('is the 513 body verbatim plus the one default-on PERFORM', () => {
    const now = stripComments(body(MIGRATION, 'create_company_with_owner'));
    const before = stripComments(body(M513, 'create_company_with_owner'));
    expect(now).toContain(PERFORM_LINE);
    expect(now.split('\n').filter((l) => l.trim() !== PERFORM_LINE).join('\n')).toBe(before);
  });

  it('calls default-on after the owner membership and before the taxonomy seed', () => {
    const b = body(MIGRATION, 'create_company_with_owner');
    const owner = b.indexOf('INSERT INTO public.company_users');
    const perform = b.indexOf(PERFORM_LINE);
    const seed = b.indexOf('PERFORM public.seed_company_default_taxonomy');
    expect(owner).toBeGreaterThan(-1);
    expect(perform).toBeGreaterThan(owner);
    expect(seed).toBeGreaterThan(perform);
  });

  it('is re-registered in app_definer_reviews', () => {
    expect(MIGRATION).toMatch(/\('create_company_with_owner\(jsonb\)', 'public\.create_company_with_owner\(jsonb\)'/);
    expect(MIGRATION).toContain('ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5');
  });
});

describe('1058: enable_mcp_connector_default', () => {
  const b = body(MIGRATION, 'enable_mcp_connector_default');

  it('is SECURITY INVOKER with a pinned search_path', () => {
    expect(b).toMatch(/SECURITY INVOKER/);
    expect(b).not.toMatch(/SECURITY DEFINER/);
    expect(b).toContain('SET search_path = pg_catalog, public, pg_temp');
  });

  it("is hard-coded to mcp_connector, never overwrites, new companies only", () => {
    expect(b).toContain("ff.code = 'mcp_connector'");
    expect(b).toMatch(/ON CONFLICT \(company_id, feature_id\) DO NOTHING/);
    expect(b).not.toMatch(/DO UPDATE/);
    expect(b).toMatch(/c\.created_at >= pg_catalog\.now\(\) - interval '10 minutes'/);
    expect(b).toContain("'Default on for new companies'");
    expect(b).toContain("'default_new_company'");
  });

  it('is not granted to app_user (only reached through create_company_with_owner)', () => {
    expect(MIGRATION).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.enable_mcp_connector_default\(uuid, uuid\) TO [^;]*app_user/);
    expect(MIGRATION).toContain('REVOKE ALL ON FUNCTION public.enable_mcp_connector_default(uuid, uuid) FROM app_user;');
  });
});

describe('1058: mcp_connector_self_serve_set', () => {
  const b = body(MIGRATION, 'mcp_connector_self_serve_set');

  it('is SECURITY DEFINER, pinned, owned by migration_admin, executable by app_user, registered', () => {
    expect(b).toMatch(/SECURITY DEFINER/);
    expect(b).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(MIGRATION).toContain('ALTER FUNCTION public.mcp_connector_self_serve_set(uuid, boolean) OWNER TO migration_admin;');
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.mcp_connector_self_serve_set(uuid, boolean) TO app_user;');
    expect(MIGRATION).toMatch(/\('mcp_connector_self_serve_set\(uuid,boolean\)', 'public\.mcp_connector_self_serve_set\(uuid, boolean\)'/);
    // registered after the owner change (930: the hash includes the owner)
    expect(MIGRATION.indexOf('INSERT INTO public.app_definer_reviews'))
      .toBeGreaterThan(MIGRATION.indexOf('OWNER TO migration_admin;\nREVOKE ALL ON FUNCTION public.mcp_connector_self_serve_set'));
  });

  it('checks the session company and the owner/admin role in SQL', () => {
    expect(b).toContain('p_company IS DISTINCT FROM app.current_company_id()');
    expect(b).toContain("cu.role IN ('owner', 'admin')");
    expect(b).toContain('cu.user_id = v_uid');
    expect(b).toContain("ff.code = 'mcp_connector'");
  });

  it('keeps the platform-admin OFF lock and never UPDATEs', () => {
    expect(b).toContain("IF p_enabled AND NOT v_was AND v_was_via = 'platform_admin' THEN");
    expect(b).toContain("COALESCE(o.set_via, 'platform_admin')");
    expect(b).toContain("'locked'::text");
    expect(stripComments(b)).not.toMatch(/\bUPDATE\b/);
    expect(b).toContain("'company_admin'");
    expect(b).toContain('pg_advisory_xact_lock');
    // The read that decides the lock happens after the advisory lock; the matching key is taken by both
    // platform-admin writes. No row lock: FOR SHARE / FOR UPDATE need UPDATE privilege, which migration_admin
    // (the owner) is not given (the integration suite runs it with UPDATE revoked).
    const lock = b.indexOf("pg_catalog.hashtextextended('mcp_connector_self_serve:' || p_company::text, 0)");
    const read = b.indexOf("SELECT o.enabled, COALESCE(o.set_via, 'platform_admin') INTO v_was, v_was_via");
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(stripComments(b)).not.toMatch(/\bFOR\s+(SHARE|UPDATE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/);
  });
});

describe('1058: set_via and the stamp trigger', () => {
  it('adds a nullable set_via with its CHECK', () => {
    expect(MIGRATION).toContain('ALTER TABLE public.company_feature_overrides ADD COLUMN IF NOT EXISTS set_via TEXT;');
    expect(MIGRATION).toContain("CHECK (set_via IS NULL OR set_via IN ('platform_admin', 'company_admin', 'default_new_company'))");
  });

  it('stamps every UPDATE platform_admin', () => {
    expect(body(MIGRATION, 'company_feature_overrides_stamp_update')).toContain("NEW.set_via := 'platform_admin';");
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON public\.company_feature_overrides\s+FOR EACH ROW EXECUTE FUNCTION public\.company_feature_overrides_stamp_update\(\)/);
  });
});

describe('1058: no backfill, no global flag, no plan', () => {
  const top = topLevel();

  it('writes no row of companies, company_feature_overrides or feature_flags outside function bodies', () => {
    expect(top).not.toMatch(/INSERT INTO (public\.)?(company_feature_overrides|companies|feature_flags)\b/i);
    expect(top).not.toMatch(/\bUPDATE (public\.)?(company_feature_overrides|companies|feature_flags)\b/i);
    expect(top).not.toMatch(/DELETE FROM (public\.)?(company_feature_overrides|companies|feature_flags)\b/i);
  });

  it('never names is_global or plan_features in SQL', () => {
    const sqlOnly = stripComments(MIGRATION);
    expect(sqlOnly).not.toMatch(/is_global/);
    expect(sqlOnly).not.toMatch(/plan_features/);
  });

  it('ends with the scoped app_pool_reach_violations halt and carries the rollback block', () => {
    expect(MIGRATION.trimEnd()).toMatch(/FOR v IN SELECT x FROM public\.app_pool_reach_violations\(\) AS x\s+WHERE x ~ 'company_feature_overrides\|create_company_with_owner\|mcp_connector_self_serve_set\|enable_mcp_connector_default'\s+ORDER BY 1 LOOP\s+RAISE EXCEPTION '1058: %', v;\s+END LOOP;\s+END \$\$;$/);
    expect(MIGRATION).toContain('-- ROLLBACK');
    expect(MIGRATION).toContain("--    WHERE ff.id = o.feature_id AND ff.code = 'mcp_connector' AND o.set_via = 'default_new_company';");
    expect(MIGRATION).not.toMatch(/DELETE FROM public\.company_feature_overrides WHERE reason/);
    expect(MIGRATION).toContain('--   DROP FUNCTION IF EXISTS public.mcp_connector_self_serve_set(uuid, boolean);');
    expect(MIGRATION).toContain('--   ALTER TABLE public.company_feature_overrides DROP COLUMN IF EXISTS set_via;');
    expect(MIGRATION).toContain('1058: company_feature_overrides does not have row security');
    expect(MIGRATION).toContain('1058: app_user can % company_feature_overrides');
  });
});
