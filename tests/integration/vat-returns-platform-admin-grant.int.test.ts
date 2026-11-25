// tests/integration/vat-returns-platform-admin-grant.int.test.ts
//
// Migration 1033: production's platform_admin had no SELECT on vat_returns (42501 in the portfolio workbench's VAT
// card, which reads each client on the platform_admin pool). From that state the migration gives SELECT and nothing
// else. platform_admin bypasses RLS, so vatPeriodFilings' company filters are the only tenant boundary: two companies'
// rows are read as that role and only the requested company's come back.
//
// Every test runs in one transaction on the fixture connection, always rolled back; platform_admin is reached with
// SET LOCAL ROLE (the harness's PLATFORM_ADMIN_DATABASE_URL is `postgres`).
import { describe, it, expect, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { runOwnedContext } from '@/lib/afterCommit';
import { listLiveCompanyMemberships } from '@/lib/auth/liveCompanies';
import { vatPeriodFilings, type VatPeriodFiling } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { buildVatCard, fmtR } from '@/modules/accounting/services/workbench/monthEndLedgerCards';
import { fixture, migration } from './s07b-app-pool-login-role.helpers';

const M1033 = migration('1033_vat_returns_platform_admin_grant.sql');
afterAll(() => fixture.end());

async function inRolledBackTx(body: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await fixture.connect();
  try {
    await c.query('BEGIN');
    await body(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Production's state: platform_admin holds nothing on the table. */
const asProduction = (c: PoolClient) => c.query('REVOKE ALL ON public.vat_returns FROM platform_admin');

/** The SQLSTATE a statement is refused with, or null; a refusal does not abort the surrounding transaction. */
async function refusal(c: PoolClient, text: string): Promise<string | null> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(text);
    await c.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return (err as { code?: string }).code ?? 'none';
  }
}

/** Every table and column privilege in the database, and vat_returns' row security. */
async function catalogue(c: PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ line: string }>(`
    SELECT format('%s %s %s%s', cl.oid::regclass, a.grantee::regrole, a.privilege_type,
             CASE WHEN a.is_grantable THEN ' GRANTABLE' ELSE '' END) AS line
      FROM pg_class cl CROSS JOIN LATERAL aclexplode(cl.relacl) a
    UNION ALL
    SELECT format('%s.%s %s %s', att.attrelid::regclass, att.attname, a.grantee::regrole, a.privilege_type)
      FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
    UNION ALL
    SELECT format('policy %s %s %s %s %s', policyname, roles, cmd, qual, with_check)
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vat_returns'
    UNION ALL
    SELECT format('rls %s forced %s', relrowsecurity, relforcerowsecurity)
      FROM pg_class WHERE oid = 'public.vat_returns'::regclass`);
  return rows.map((r) => r.line).sort();
}

describe('1033: platform_admin may read vat_returns, and no more', () => {
  it('refused before; after it (applied twice) SELECT works and every write is still refused', async () => {
    await inRolledBackTx(async (c) => {
      await asProduction(c);
      await c.query('SET LOCAL ROLE platform_admin');
      expect(await refusal(c, 'SELECT * FROM public.vat_returns')).toBe('42501');
      await c.query('RESET ROLE');

      await c.query(M1033);
      await c.query(M1033);

      await c.query('SET LOCAL ROLE platform_admin');
      expect(await refusal(c, 'SELECT * FROM public.vat_returns')).toBeNull();
      for (const write of [
        `INSERT INTO public.vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
         SELECT gen_random_uuid(), '2026-01-01', '2026-02-28', 0, 0, 0 WHERE false`,
        `UPDATE public.vat_returns SET status = status WHERE false`,
        `DELETE FROM public.vat_returns WHERE false`,
        `TRUNCATE public.vat_returns`,
      ]) expect(await refusal(c, write), write).toBe('42501');
    });
  }, 60000);

  it('adds exactly one privilege: no other table, role, grant option, policy or row-security change', async () => {
    await inRolledBackTx(async (c) => {
      await asProduction(c);
      const before = await catalogue(c);
      await c.query(M1033);
      const after = await catalogue(c);
      expect(after.filter((l) => !before.includes(l))).toEqual(['vat_returns platform_admin SELECT']);
      expect(before.filter((l) => !after.includes(l))).toEqual([]);
    });
  }, 60000);

  it('leaves a database without the role alone', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('ALTER ROLE platform_admin RENAME TO platform_admin_absent_1033');
      const before = await catalogue(c);
      await c.query(M1033);
      expect(await catalogue(c)).toEqual(before);
    });
  }, 60000);

  it('raises when the grant does not take (run by a role that may not grant it)', async () => {
    await inRolledBackTx(async (c) => {
      await asProduction(c);
      await c.query('SET LOCAL ROLE migration_admin');
      await expect(c.query(M1033)).rejects.toThrow(/1033: platform_admin still lacks SELECT on vat_returns/);
    });
  }, 60000);
});

type Period = readonly [start: string, end: string];
const B_ONLY: Period = ['2026-01-01', '2026-02-28'];
const BOTH_VERSIONED: Period = ['2026-03-01', '2026-04-30'];
const BOTH_LEGACY: Period = ['2026-05-01', '2026-06-30'];
/** A holds a legacy row for it, B a lifecycle version. */
const CROSSED: Period = ['2026-07-01', '2026-08-31'];
const YEAR = { from: '2026-01-01', to: '2026-12-31' };

async function company(c: PoolClient, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [id, name]);
  return id;
}

/** A finalised VAT201 version of `net`, with the period lock it needs. */
async function version(c: PoolClient, companyId: string, [start, end]: Period, net: number): Promise<string> {
  const lock = await c.query<{ id: string }>(`INSERT INTO vat_period_locks
      (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
    VALUES ($1, $2, $3, $4, 0, $4, now(), '1033') RETURNING id`, [companyId, start, end, net]);
  const v = await c.query<{ id: string }>(`INSERT INTO tax_return_versions
      (company_id, form_type, period_start, period_end, version_no, figures, posted_through, vat_period_lock_id, finalised_by)
    VALUES ($1, 'VAT201', $2, $3, 1, $4, now(), $5, '1033') RETURNING id`,
  [companyId, start, end, JSON.stringify({ outputTax: net, inputTax: 0, netVat: net }), lock.rows[0]!.id]);
  return v.rows[0]!.id;
}

async function vatReturn(c: PoolClient, companyId: string, [start, end]: Period, net: number, versionId: string | null = null) {
  await c.query(`INSERT INTO vat_returns
      (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat, status, return_version_id)
    VALUES ($1, $2, $3, $4, 0, $4, 'submitted', $5)`, [companyId, start, end, net, versionId]);
}

/** Companies A and B with filings over the same periods and amounts that tell them apart. */
async function twoTenants(c: PoolClient): Promise<{ a: string; b: string }> {
  const a = await company(c, '1033 tenant A');
  const b = await company(c, '1033 tenant B');
  await vatReturn(c, a, BOTH_VERSIONED, 1000, await version(c, a, BOTH_VERSIONED, 1000));
  await vatReturn(c, b, BOTH_VERSIONED, 8000, await version(c, b, BOTH_VERSIONED, 8000));
  await version(c, b, B_ONLY, 6000);
  await vatReturn(c, a, BOTH_LEGACY, 200);
  await vatReturn(c, b, BOTH_LEGACY, 7000);
  await vatReturn(c, a, CROSSED, 40);
  await version(c, b, CROSSED, 5000);
  return { a, b };
}

/** Run `fn` with `sql` bound to this connection as platform_admin, as the portfolio workbench binds its client. */
async function asPlatformAdmin<T>(c: PoolClient, companyId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('SET LOCAL ROLE platform_admin');
  expect((await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u).toBe('platform_admin');
  return runOwnedContext({ client: c, userId: '1033', companyId, claims: {} }, fn);
}

/** [company, period start, source, the filing's net VAT, settlement rows, settled net VAT] */
const digest = (f: VatPeriodFiling) =>
  [f.companyId, f.periodStart, f.source, f.netVat, f.settlement?.count ?? 0, f.settlement?.netVat ?? null];

describe('1033: read as platform_admin (BYPASSRLS), vat_returns stays scoped to the requested company', () => {
  it('the VAT card fails with 42501 before the migration and reads its own company after it', async () => {
    await inRolledBackTx(async (c) => {
      const { a } = await twoTenants(c);
      await asProduction(c);
      await c.query('SAVEPOINT before_grant');
      await expect(asPlatformAdmin(c, a, () => buildVatCard(a, ...BOTH_VERSIONED))).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT before_grant');

      await c.query(M1033);
      const versioned = await asPlatformAdmin(c, a, () => buildVatCard(a, ...BOTH_VERSIONED));
      expect(versioned).toMatchObject({ status: 'ready', primary: `${fmtR(1000)} payable` });
      const legacy = await asPlatformAdmin(c, a, () => buildVatCard(a, ...CROSSED));
      expect(legacy).toMatchObject({ status: 'ready', primary: `${fmtR(40)} payable`, secondary: 'submitted' });
    });
  }, 60000);

  it('vatPeriodFilings returns only the requested company, settlements and legacy rows included', async () => {
    await inRolledBackTx(async (c) => {
      const { a, b } = await twoTenants(c);
      await asProduction(c);
      await c.query(M1033);

      const mine = await asPlatformAdmin(c, a, () => vatPeriodFilings([a], YEAR));
      expect(mine.map(digest)).toEqual([
        [a, BOTH_VERSIONED[0], 'lifecycle', 1000, 1, 1000],
        [a, BOTH_LEGACY[0], 'legacy', 200, 1, 200],
        [a, CROSSED[0], 'legacy', 40, 1, 40],
      ]);
      const theirs = await asPlatformAdmin(c, b, () => vatPeriodFilings([b], YEAR));
      expect(theirs.map(digest)).toEqual([
        [b, B_ONLY[0], 'lifecycle', 6000, 0, null],
        [b, BOTH_VERSIONED[0], 'lifecycle', 8000, 1, 8000],
        [b, BOTH_LEGACY[0], 'legacy', 7000, 1, 7000],
        [b, CROSSED[0], 'lifecycle', 5000, 0, null],
      ]);
    });
  }, 60000);

  it('the portfolio\'s company ids are the caller\'s own memberships', async () => {
    await inRolledBackTx(async (c) => {
      const { a, b } = await twoTenants(c);
      const [mine, other] = [crypto.randomUUID(), crypto.randomUUID()];
      for (const [user, companyId] of [[mine, a], [other, b]] as const) {
        await c.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active, status)
          VALUES ($1, $2, 'V', 'R', 'viewer', true, 'active')`, [user, `${user}@test.local`]);
        await c.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)`,
          [companyId, user]);
      }
      // As `postgres`, which no row security narrows: the query's own user filter is what is under test.
      const list = await runOwnedContext({ client: c, userId: mine, companyId: a, claims: {} },
        () => listLiveCompanyMemberships(mine));
      expect(list.map((m) => m.companyId)).toEqual([a]);
    });
  }, 60000);
});
