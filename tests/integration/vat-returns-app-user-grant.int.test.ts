// tests/integration/vat-returns-app-user-grant.int.test.ts
//
// Migration 1003: production's app_user had no privilege on vat_returns (42501 in the month-end workbench's VAT
// card). From the broken state (every privilege revoked, policies dropped) the migration gives app_user exactly
// SELECT, INSERT, UPDATE and DELETE, keeps forced RLS with a policy for app_user, and applies twice.
import { describe, it, expect, afterAll } from 'vitest';
import { closeSql } from '../../scripts/_pg';
import { migration, rolledBack } from './s07b-app-pool-login-role.helpers';

const M1003 = migration('1003_vat_returns_app_user_grant.sql');
afterAll(() => closeSql());

type Q = (text: string) => Promise<unknown>;
const rows = async (q: Q, text: string) => ((await q(text)) as { rows: Array<Record<string, unknown>> }).rows;
const priv = async (q: Q, p: string) =>
  (await rows(q, `SELECT has_table_privilege('app_user', 'public.vat_returns', '${p}') AS ok`))[0]!.ok;

describe('1003: vat_returns grant', () => {
  it('restores SELECT/INSERT/UPDATE/DELETE to app_user from a bare table, twice, with RLS and a policy', async () => {
    await rolledBack(async (q) => {
      await q('REVOKE ALL ON public.vat_returns FROM app_user');
      await q(`DO $$ DECLARE p text; BEGIN FOR p IN SELECT policyname FROM pg_policies
        WHERE tablename = 'vat_returns' AND 'app_user' = ANY (roles) LOOP
        EXECUTE format('DROP POLICY %I ON public.vat_returns', p); END LOOP; END $$`);
      expect(await priv(q, 'SELECT')).toBe(false);
      for (let i = 0; i < 2; i++) await q(M1003);
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await priv(q, p), p).toBe(true);
      for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await priv(q, p), p).toBe(false);
      const [t] = await rows(q, `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid = 'public.vat_returns'::regclass`);
      expect(t).toEqual({ rls: true, forced: true });
      const pol = await rows(q, `SELECT policyname FROM pg_policies
        WHERE tablename = 'vat_returns' AND 'app_user' = ANY (roles)`);
      expect(pol.length).toBe(1);
    });
  }, 60000);

  it('does not clash with an existing tenant_isolation policy on another role', async () => {
    await rolledBack(async (q) => {
      await q('REVOKE ALL ON public.vat_returns FROM app_user');
      await q(`DO $$ DECLARE p text; BEGIN FOR p IN SELECT policyname FROM pg_policies
        WHERE tablename = 'vat_returns' AND 'app_user' = ANY (roles) LOOP
        EXECUTE format('DROP POLICY %I ON public.vat_returns', p); END LOOP; END $$`);
      await q('DROP POLICY IF EXISTS tenant_isolation ON public.vat_returns');
      await q('CREATE POLICY tenant_isolation ON public.vat_returns FOR SELECT TO migration_admin USING (true)');
      await q(M1003);
      expect(await priv(q, 'SELECT')).toBe(true);
      const pol = await rows(q, `SELECT policyname FROM pg_policies
        WHERE tablename = 'vat_returns' AND 'app_user' = ANY (roles)`);
      expect(pol).toEqual([{ policyname: 'vat_returns_tenant_isolation' }]);
    });
  }, 60000);

  it('refuses when a permissive policy for app_user does not scope by company_id', async () => {
    await rolledBack(async (q) => {
      await q(`DO $$ DECLARE p text; BEGIN FOR p IN SELECT policyname FROM pg_policies
        WHERE tablename = 'vat_returns' AND 'app_user' = ANY (roles) LOOP
        EXECUTE format('DROP POLICY %I ON public.vat_returns', p); END LOOP; END $$`);
      await q('CREATE POLICY open_all ON public.vat_returns FOR ALL TO app_user USING (true)');
      await expect(q(M1003)).rejects.toThrow(/does not scope by company_id/);
    });
  }, 60000);
});
