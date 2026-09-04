/**
 * System account roles, proven against a real Postgres.
 *
 * Mocking `sql` here would prove nothing that matters. The defect was that
 * production charts did not contain rows nobody had checked for, and a mocked
 * template returns whatever the test author already believed. `yearEndService`
 * INSERTed two columns that exist in no environment and its tests passed
 * throughout, because they mocked `tx`.
 *
 * THE LOAD-BEARING TEST IS `a brand-new tenant`. Everything else here inspects
 * charts that already exist; that one creates a company through the same
 * function `create_company_with_owner` calls and then resolves all fourteen
 * roles against it. It is the state every future customer starts in, and the
 * only test that actually proves migration 605 fixed the seed rather than
 * proving 606 patched the tenants we happen to have.
 *
 * This test WRITES, so it refuses to run against production. Everything happens
 * inside one transaction that is rolled back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { SYSTEM_ACCOUNT_KEYS, MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { getSystemRoleCoverage } from '@/modules/accounting/services/gl/systemRoleCoverage';
import {
  getSystemAccount,
  clearSystemAccountCache,
} from '@/modules/accounting/services/gl/systemAccountResolver';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const BRIGHTSPHERE = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const DEMO = '00000000-0000-0000-0000-000000000001';

let client: PoolClient | null = null;
let reachable = false;

function ctxFor(companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

/** Run `fn` with the transaction client bound, and the resolver cache cleared. */
async function asCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  clearSystemAccountCache(companyId);
  return als.run(ctxFor(companyId), fn);
}

beforeAll(async () => {
  reachable = await isDbReachable();
  if (!reachable) return;
  assertNotProductionDb('creates a company and GL accounts, then rolls back');
  client = await getPoolForTests().connect();
  await client.query('BEGIN');
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
});

/**
 * Fail rather than skip when the DB is up but the fixture cannot be built.
 *
 * A fixture that returns early on a missing precondition turns every assertion
 * below it into a green no-op — the failure mode is indistinguishable from a
 * passing suite. Skipping is only correct when there is no database at all,
 * which `isDbReachable` decides once, up front.
 */
function requireDb(): void {
  if (!reachable) return;
  if (!client) throw new Error('DB reachable but no client — fixture is broken, not skipped');
}

describe.skipIf(!process.env.DATABASE_URL)('system account roles (DB)', () => {
  it('a brand-new tenant can resolve all fourteen roles', async () => {
    if (!reachable) return;
    requireDb();
    const c = client!;

    // The same seeder `create_company_with_owner` invokes, so this exercises
    // migration 605's template and not a hand-built chart.
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO companies (name, registered_name, country, default_currency)
       VALUES ('ZZTEST Empty Tenant', 'ZZTEST Empty Tenant', 'South Africa', 'ZAR')
       RETURNING id`,
    );
    const companyId = rows[0].id;

    // Before seeding: genuinely empty, so the assertion below cannot pass by
    // accident on a chart that was already there.
    const { rows: before } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM gl_accounts WHERE company_id = $1`,
      [companyId],
    );
    expect(before[0].n).toBe('0');

    await c.query(`SELECT public.seed_company_default_taxonomy($1)`, [companyId]);

    const resolved: string[] = [];
    for (const key of SYSTEM_ACCOUNT_KEYS) {
      const account = await asCompany(companyId, () => getSystemAccount(key, companyId));
      expect(account.accountSubtype).toBe(key);
      resolved.push(`${key}=${account.accountCode}`);
    }
    expect(resolved).toHaveLength(14);

    const coverage = await asCompany(companyId, () => getSystemRoleCoverage(companyId));
    expect(coverage.empty).toEqual([]);
    expect(coverage.contested).toEqual([]);
    expect(coverage.roles).toHaveLength(14);

    // The two roles migration 605 added, at the codes that were signed off.
    const byRole = new Map(coverage.roles.map((r) => [r.key, r.holder?.accountCode]));
    expect(byRole.get('disposal_profit_loss')).toBe('4410');
    expect(byRole.get('opening_balance_equity')).toBe('3300');
    // The one that was a flag rather than an account.
    expect(byRole.get('other_income')).toBe('4300');
  });

  /**
   * The breadth claim migration 606 actually makes, over the companies it names.
   *
   * An earlier version of this asserted over EVERY company with any GL account
   * and failed in the full suite while passing alone: other test files leave
   * behind single-account fixture tenants ("Line lock fixture co", 1 account
   * each, 15 of them) which 606 makes no claim about and which are not tenants
   * in any meaningful sense. Widening an assertion until it catches unrelated
   * fixtures does not make it stronger, it makes it flaky.
   *
   * Restricted to the ids present in THIS database, because dev holds a subset
   * of production's — but it fails rather than passes if that subset is empty,
   * so it cannot go green by matching nothing.
   */
  it('every production tenant migration 606 names holds all fourteen roles', async () => {
    if (!reachable) return;
    requireDb();
    const c = client!;

    // The 13 companies measured in production on 2026-09-04.
    const PRODUCTION_TENANTS = [
      'd27bac33-cdc0-4e58-bf6b-709c1597d41c', // Brightsphere Technologies
      '779d1c87-b9ad-4c4b-8b6c-497421fd2654', // Dotbiz
      '9f4cccf9-5892-4155-b5a8-6ca460641542', // Dotbiz (Pty) Ltd
      '1d038805-3663-4e72-9daa-6ae9f11eefa3', // EG Plumbing and Services
      'd6184044-047a-4ae7-bc97-c9a3a136e66a', // H10 Holdings
      '00000000-0000-0000-0000-000000000001', // ISAFlow Demo
      '915b7146-cb2a-4e81-8705-3022fda40a0c', // My Test Company
      'fa3530e2-1abf-4fb1-a3ad-313ed6d977c2', // QA-COMPANY-DELETE-ME
      'cd6445b7-3d0b-42c3-931e-10c7908cceb8', // Test Company E2E
      'c40414ea-1e1d-444c-887b-d371f2195dbd', // Test Company E2E
      '9920c69d-f581-42d4-af58-198d741924ad', // Test Company E2E
      '4a159669-2f50-46b5-a7b8-2e94dab3d495', // Velocity Fibre
      '661a92be-2cd5-43fe-a841-d3b50cf740d1', // Weszak Beleggings
    ];

    const { rows: present } = await c.query<{ id: string }>(
      `SELECT id::text AS id FROM companies WHERE id = ANY($1::uuid[])`,
      [PRODUCTION_TENANTS],
    );
    // Not a skip. If none of them is here the assertions below would pass by
    // examining nothing, which is the failure mode this whole workstream is
    // about.
    expect(present.length, 'none of the production tenants exist in this database').toBeGreaterThan(0);

    const empties: string[] = [];
    for (const { id } of present) {
      const coverage = await asCompany(id, () => getSystemRoleCoverage(id));
      for (const role of coverage.empty) empties.push(`${id} ${role.key}:${role.gap}`);
    }
    expect(empties).toEqual([]);
  });

  it('reports the near miss rather than a bare absence, and tells the two shapes apart', async () => {
    if (!reachable) return;
    requireDb();
    const c = client!;

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO companies (name, registered_name, country, default_currency)
       VALUES ('ZZTEST Near Miss', 'ZZTEST Near Miss', 'South Africa', 'ZAR')
       RETURNING id`,
    );
    const companyId = rows[0].id;
    await c.query(`SELECT public.seed_company_default_taxonomy($1)`, [companyId]);

    // Reproduce production's `other_income`: the account is there, active, right
    // subtype, and is_system_account is false.
    await c.query(
      `UPDATE gl_accounts SET is_system_account = false
        WHERE company_id = $1 AND account_subtype = 'other_income'`,
      [companyId],
    );
    // Reproduce Brightsphere's `admin_expense`: system flag intact, deactivated.
    await c.query(
      `UPDATE gl_accounts SET is_active = false
        WHERE company_id = $1 AND account_subtype = 'admin_expense'`,
      [companyId],
    );
    // And a role with nothing at all.
    await c.query(
      `UPDATE gl_accounts SET account_subtype = NULL, is_system_account = false
        WHERE company_id = $1 AND account_subtype = 'disposal_profit_loss'`,
      [companyId],
    );

    const coverage = await asCompany(companyId, () => getSystemRoleCoverage(companyId));
    const gaps = new Map(coverage.empty.map((r) => [r.key, r.gap]));
    expect(gaps.get('other_income')).toBe('unflagged_active_claimant');
    expect(gaps.get('admin_expense')).toBe('deactivated_claimants_only');
    expect(gaps.get('disposal_profit_loss')).toBe('no_claimant');
    expect(coverage.empty).toHaveLength(3);

    // The unflagged case must name the account, so the operator fixes the
    // column instead of creating a second account.
    const otherIncome = coverage.empty.find((r) => r.key === 'other_income');
    expect(otherIncome?.claimants.map((x) => x.accountCode)).toEqual(['4300']);

    // And the resolver refuses with the same classification rather than a raw Error.
    const err = await asCompany(companyId, () =>
      getSystemAccount('other_income', companyId).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeInstanceOf(MissingSystemAccountError);
    expect((err as MissingSystemAccountError).gap).toBe('unflagged_active_claimant');
    expect((err as MissingSystemAccountError).nearMisses[0].accountCode).toBe('4300');
  });

  it('Brightsphere and the demo tenant resolve every role after the backfill', async () => {
    if (!reachable) return;
    requireDb();
    const c = client!;

    for (const companyId of [BRIGHTSPHERE, DEMO]) {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM companies WHERE id = $1`,
        [companyId],
      );
      // These two are seeded in every environment this suite runs against. If
      // one is absent the assertion below would silently prove nothing, so say
      // so instead.
      expect(rows[0].n, `company ${companyId} is missing from this database`).toBe('1');

      const coverage = await asCompany(companyId, () => getSystemRoleCoverage(companyId));
      expect(
        coverage.empty.map((r) => `${r.key}:${r.gap}`),
        `${companyId} has empty system roles`,
      ).toEqual([]);
    }
  });
});
