/**
 * Migration 947 in the catalog: every function it creates is SECURITY INVOKER (no definer, so no
 * app_definer_reviews row); app_user cannot TRUNCATE either budget table (the lock trigger does not
 * cover TRUNCATE); budget_versions has forced RLS and its app_service mirror policies; the guard,
 * audit, lock and kind triggers are ENABLE ALWAYS; the NL view is security_invoker.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());

const text = readFileSync(new URL('../../scripts/migrations/sql/947_budget_versions.sql', import.meta.url), 'utf8');
const created = [...text.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]!);

describe('947 catalog', () => {
  it('creates the functions it says it does, and none is SECURITY DEFINER', async () => {
    expect(created).toEqual(expect.arrayContaining([
      'budget_versions_guard', 'budget_versions_audit', 'budget_month_amounts_dimension_kinds', 'budget_month_amounts_refuse_locked',
      'budget_version_original', 'budget_month_registry_label', 'budget_versions_from_months', 'budget_versions_snapshot',
      'budget_versions_parity_mismatches', 'budget_months_from_legacy', 'cost_centres_keep_budget_kind']));
    const rows = (await pool.query(
      `SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [created])).rows;
    expect(new Set(rows.map((r) => r.proname))).toEqual(new Set(created));
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([]);
  });

  it('app_user (and so both app logins) has no TRUNCATE on budget_versions or budget_month_amounts', async () => {
    const r = (await pool.query(
      `SELECT has_table_privilege('app_user', 'budget_versions', 'TRUNCATE') v, has_table_privilege('app_user', 'budget_month_amounts', 'TRUNCATE') m`)).rows[0];
    expect(r).toEqual({ v: false, m: false });
  });

  it('budget_versions has forced RLS, the tenant policy and the app_service mirror policies', async () => {
    const rel = (await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.budget_versions'::regclass`)).rows[0];
    expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = (await pool.query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'budget_versions' ORDER BY 1`)).rows.map((r) => r.policyname);
    expect(policies).toEqual(['app_service_delete', 'app_service_insert', 'app_service_select', 'app_service_update', 'tenant_isolation']);
  });

  it('the guard, audit, lock and kind triggers fire ALWAYS (also under replica)', async () => {
    const rows = (await pool.query(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1) ORDER BY 1`,
      [['trg_budget_versions_guard', 'trg_budget_versions_audit', 'trg_budget_month_amounts_refuse_locked', 'trg_budget_month_amounts_dimension_kinds',
        'trg_cost_centres_keep_budget_kind']])).rows;
    expect(rows).toEqual([
      { tgname: 'trg_budget_month_amounts_dimension_kinds', tgenabled: 'A' },
      { tgname: 'trg_budget_month_amounts_refuse_locked', tgenabled: 'A' },
      { tgname: 'trg_budget_versions_audit', tgenabled: 'A' },
      { tgname: 'trg_budget_versions_guard', tgenabled: 'A' },
      { tgname: 'trg_cost_centres_keep_budget_kind', tgenabled: 'A' },
    ]);
  });

  it('the NL view is security_invoker and readable by app_user', async () => {
    const r = (await pool.query(
      `SELECT reloptions, has_table_privilege('app_user', 'budget_primary_month_amounts', 'SELECT') sel
         FROM pg_class WHERE oid = 'public.budget_primary_month_amounts'::regclass`)).rows[0];
    expect(r.reloptions).toContain('security_invoker=true');
    expect(r.sel).toBe(true);
  });
});
