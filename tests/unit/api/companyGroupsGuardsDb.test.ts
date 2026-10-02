/**
 * D4 round 10 (security review of 5446d243c), against Postgres: the REAL company-groups handler
 * and guards over connection-local temp tables, rolled back.
 *  1. set-mapping with another tenant's gl_accounts id / another group's group_accounts id → 400,
 *     nothing stored, and GET mappings shows nothing of the foreign account (it used to return
 *     the foreign account's code and name).
 *  2. auto-generate-coa / auto-map / set-mapping: the company must be a current member of the
 *     group (400) and the caller needs a write role in it (403).
 *  4. creator add-member bootstrap: only while every current member is a company the creator
 *     still belongs to.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/company-groups';

const G = '80000000-0000-4000-8000-000000000001';      // the attacker's group
const G2 = '80000000-0000-4000-8000-000000000002';     // someone else's group
const MINE = '10000000-0000-4000-8000-0000000000a1';   // member of G, attacker is admin
const VIEWED = '10000000-0000-4000-8000-0000000000a2'; // member of G, attacker is only a viewer
const OUTSIDE = '10000000-0000-4000-8000-0000000000a3';// not in G, attacker is admin
const VICTIM = '10000000-0000-4000-8000-0000000000ff'; // another tenant entirely
const acct = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gacct = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function withGroups(run: () => Promise<void>) {
  assertNotProductionDb('company-groups guards');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: MINE, userId: 'attacker', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE company_groups (id uuid, name text, holding_company_id uuid, default_currency text,
        financial_year_start int, is_active boolean, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE company_group_members (id uuid DEFAULT gen_random_uuid(), group_id uuid, company_id uuid,
        ownership_pct numeric, consolidation_method text, is_holding boolean DEFAULT false, joined_date date, left_date date,
        created_at timestamptz DEFAULT now()) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE company_users (company_id uuid, user_id text, role text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_accounts (id uuid, company_id uuid, account_code text, account_name text,
        account_type text, is_active boolean DEFAULT true) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE group_accounts (id uuid, group_id uuid, account_code text, account_name text, account_type text,
        account_subtype text, parent_account_id uuid, normal_balance text, level int, display_order int,
        is_active boolean DEFAULT true, created_at timestamptz DEFAULT now()) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE group_coa_mappings (id uuid DEFAULT gen_random_uuid(), group_id uuid, group_account_id uuid,
        company_id uuid, company_account_id uuid, created_at timestamptz DEFAULT now(),
        UNIQUE (group_id, company_id, company_account_id)) ON COMMIT DROP`;
      await sql`INSERT INTO company_groups (id, name, created_by) VALUES
        (${G}::uuid, 'Mine', '90000000-0000-4000-8000-000000000001'), (${G2}::uuid, 'Theirs', NULL)`;
      await sql`INSERT INTO company_group_members (group_id, company_id) VALUES
        (${G}::uuid, ${MINE}::uuid), (${G}::uuid, ${VIEWED}::uuid), (${G2}::uuid, ${VICTIM}::uuid)`;
      await sql`INSERT INTO company_users VALUES (${MINE}::uuid, 'attacker', 'admin'), (${VIEWED}::uuid, 'attacker', 'viewer'),
        (${OUTSIDE}::uuid, 'attacker', 'admin'), (${VICTIM}::uuid, 'victim', 'owner')`;
      await sql`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type) VALUES
        (${acct(1)}::uuid, ${MINE}::uuid, '1000', 'Bank', 'asset'),
        (${acct(9)}::uuid, ${VICTIM}::uuid, '9999', 'VICTIM SECRET LOAN', 'liability')`;
      await sql`INSERT INTO group_accounts (id, group_id, account_code, account_name, account_type) VALUES
        (${gacct(1)}::uuid, ${G}::uuid, 'G1000', 'Cash', 'asset'),
        (${gacct(9)}::uuid, ${G2}::uuid, 'X9999', 'OTHER GROUP SECRET', 'liability')`;
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

async function call(method: string, user: string, body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  const res = { statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(
    { method, query, body, user: { id: user } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

describe('company-groups guards (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('set-mapping refuses a foreign tenant account / another group account, and nothing leaks', async () => {
    await withGroups(async () => {
      const foreignCompany = await call('POST', 'attacker', { action: 'set-mapping', groupId: G, companyId: MINE, companyAccountId: acct(9), groupAccountId: gacct(1) });
      expect([foreignCompany.statusCode, JSON.stringify(foreignCompany.sent)]).toEqual([400, expect.stringContaining('companyAccountId is not an account of that company')]);
      const foreignGroup = await call('POST', 'attacker', { action: 'set-mapping', groupId: G, companyId: MINE, companyAccountId: acct(1), groupAccountId: gacct(9) });
      expect([foreignGroup.statusCode, JSON.stringify(foreignGroup.sent)]).toEqual([400, expect.stringContaining('groupAccountId is not an account of this group')]);
      expect(await sql`SELECT count(*)::int AS n FROM group_coa_mappings`).toEqual([{ n: 0 }]);
      const listed = await call('GET', 'attacker', {}, { action: 'mappings', group_id: G });
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.sent)).not.toMatch(/VICTIM SECRET LOAN|OTHER GROUP SECRET|9999/);
      // The legitimate mapping still works.
      const ok = await call('POST', 'attacker', { action: 'set-mapping', groupId: G, companyId: MINE, companyAccountId: acct(1), groupAccountId: gacct(1) });
      expect(ok.statusCode).toBe(200);
    });
  });

  it.skipIf(!reachable)('auto-generate-coa / auto-map / set-mapping: company must be a group member (400) the caller can write (403)', async () => {
    await withGroups(async () => {
      for (const [action, field] of [['auto-generate-coa', 'sourceCompanyId'], ['auto-map', 'companyId'], ['set-mapping', 'companyId']] as const) {
        const extra = action === 'set-mapping' ? { companyAccountId: acct(1), groupAccountId: gacct(1) } : {};
        const outside = await call('POST', 'attacker', { action, groupId: G, [field]: OUTSIDE, ...extra });
        expect([action, outside.statusCode, JSON.stringify(outside.sent)]).toEqual([action, 400, expect.stringContaining('not a member of this group')]);
        const viewer = await call('POST', 'attacker', { action, groupId: G, [field]: VIEWED, ...extra });
        expect([action, viewer.statusCode, JSON.stringify(viewer.sent)]).toEqual([action, 403, expect.stringContaining('owner, admin or manager role in that company')]);
      }
      // GET mappings / unmapped for a company outside the group → 400.
      expect((await call('GET', 'attacker', {}, { action: 'mappings', group_id: G, company_id: OUTSIDE })).statusCode).toBe(400);
      expect((await call('GET', 'attacker', {}, { action: 'unmapped', group_id: G, company_id: OUTSIDE })).statusCode).toBe(400);
    });
  });

  // Round 11: a company that has LEFT the group is no longer one of its members for any mapping route.
  it.skipIf(!reachable)('a company that left the group is refused on every mapping route (400)', async () => {
    await withGroups(async () => {
      await sql`INSERT INTO company_group_members (group_id, company_id, left_date) VALUES (${G}::uuid, ${OUTSIDE}::uuid, '2026-01-31')`;
      for (const body of [
        { action: 'auto-generate-coa', groupId: G, sourceCompanyId: OUTSIDE },
        { action: 'auto-map', groupId: G, companyId: OUTSIDE },
        { action: 'set-mapping', groupId: G, companyId: OUTSIDE, companyAccountId: acct(1), groupAccountId: gacct(1) },
      ]) {
        const res = await call('POST', 'attacker', body);
        expect([body.action, res.statusCode, JSON.stringify(res.sent)]).toEqual([body.action, 400, expect.stringContaining('not a member of this group')]);
      }
      for (const action of ['mappings', 'unmapped']) {
        expect([action, (await call('GET', 'attacker', {}, { action, group_id: G, company_id: OUTSIDE })).statusCode]).toEqual([action, 400]);
      }
    });
  });

  // Round 11: a mapping row stored BEFORE the write guard (forged directly here) must not leak the
  // foreign account's code or name through GET mappings.
  it.skipIf(!reachable)('a pre-existing forged mapping row leaks nothing through GET mappings', async () => {
    await withGroups(async () => {
      await sql`INSERT INTO group_coa_mappings (group_id, company_id, company_account_id, group_account_id) VALUES
        (${G}::uuid, ${MINE}::uuid, ${acct(9)}::uuid, ${gacct(1)}::uuid),
        (${G}::uuid, ${MINE}::uuid, ${acct(1)}::uuid, ${gacct(9)}::uuid)`;
      for (const query of [{ action: 'mappings', group_id: G }, { action: 'mappings', group_id: G, company_id: MINE }]) {
        const listed = await call('GET', 'attacker', {}, query);
        expect(listed.statusCode).toBe(200);
        expect(JSON.stringify(listed.sent)).not.toMatch(/VICTIM SECRET LOAN|OTHER GROUP SECRET|9999/);
        expect((listed.sent as { data: { items: unknown[] } }).data.items).toEqual([]);
      }
    });
  });

  // Round 11: removing a company's mapping needs a write role in that company, as set-mapping does.
  it.skipIf(!reachable)('remove-mapping needs a write role in the mapped company; an unknown mapping is a 404', async () => {
    await withGroups(async () => {
      await sql`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type) VALUES
        (${acct(2)}::uuid, ${VIEWED}::uuid, '2000', 'Creditors', 'liability')`;
      const [viewedMap, mineMap] = (await sql`INSERT INTO group_coa_mappings (group_id, company_id, company_account_id, group_account_id) VALUES
        (${G}::uuid, ${VIEWED}::uuid, ${acct(2)}::uuid, ${gacct(1)}::uuid), (${G}::uuid, ${MINE}::uuid, ${acct(1)}::uuid, ${gacct(1)}::uuid)
        RETURNING id`) as Array<{ id: string }>;
      const remove = (id: string) => call('DELETE', 'attacker', {}, { action: 'remove-mapping', mapping_id: id, group_id: G });
      // A group writer (admin of MINE) who is only a viewer of VIEWED cannot remove VIEWED's mapping.
      const refused = await remove(viewedMap!.id);
      expect([refused.statusCode, JSON.stringify(refused.sent)]).toEqual([403, expect.stringContaining('owner, admin or manager role in that company')]);
      expect(await sql`SELECT count(*)::int AS n FROM group_coa_mappings`).toEqual([{ n: 2 }]);
      expect((await remove(mineMap!.id)).statusCode).toBe(200);
      expect(await sql`SELECT count(*)::int AS n FROM group_coa_mappings`).toEqual([{ n: 1 }]);
      expect((await remove('70000000-0000-4000-8000-0000000000ee')).statusCode).toBe(404);
    });
  });

  // Round 11 (test gap): the bootstrap is the CREATOR's. Someone else who belongs to every member
  // company but holds no write role in the group cannot add a member.
  it.skipIf(!reachable)('a non-creator who belongs to every member company, as a viewer, cannot add a member', async () => {
    await withGroups(async () => {
      const NEW_CO = '10000000-0000-4000-8000-0000000000c1';
      await sql`INSERT INTO company_users VALUES (${MINE}::uuid, 'onlooker', 'viewer'), (${VIEWED}::uuid, 'onlooker', 'viewer'),
        (${NEW_CO}::uuid, 'onlooker', 'owner')`;
      const res = await call('POST', 'onlooker', { action: 'add-member', groupId: G, companyId: NEW_CO });
      expect([res.statusCode, JSON.stringify(res.sent)]).toEqual([403, expect.stringContaining('does not allow this change')]);
      expect(await sql`SELECT count(*)::int AS n FROM company_group_members WHERE company_id = ${NEW_CO}::uuid`).toEqual([{ n: 0 }]);
    });
  });

  it.skipIf(!reachable)('creator bootstrap holds only while every member is a company the creator still belongs to', async () => {
    await withGroups(async () => {
      const CREATOR = '90000000-0000-4000-8000-000000000001';
      const NEW_CO = '10000000-0000-4000-8000-0000000000b1';
      await sql`INSERT INTO company_users VALUES (${NEW_CO}::uuid, ${CREATOR}, 'owner')`;
      const add = () => call('POST', CREATOR, { action: 'add-member', groupId: G, companyId: NEW_CO });
      // G already holds MINE and VIEWED, which the creator does not belong to → no bootstrap.
      expect((await add()).statusCode).toBe(403);
      // Empty the group: the creator may bootstrap it.
      await sql`UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = ${G}::uuid`;
      expect((await add()).statusCode).toBe(200);
      // Now G holds only the creator's own company → still bootstrap.
      const OWN2 = '10000000-0000-4000-8000-0000000000b2';
      await sql`INSERT INTO company_users VALUES (${OWN2}::uuid, ${CREATOR}, 'owner')`;
      expect((await call('POST', CREATOR, { action: 'add-member', groupId: G, companyId: OWN2 })).statusCode).toBe(200);
      // The creator leaves both member companies: they are no longer the creator's own, and the
      // creator holds no write role in the group either, so they can add nothing more.
      // (While they still owned OWN2 they would pass as a group writer, not via the bootstrap.)
      await sql`DELETE FROM company_users WHERE company_id = ANY(${[NEW_CO, OWN2]}::uuid[]) AND user_id = ${CREATOR}`;
      const OWN3 = '10000000-0000-4000-8000-0000000000b3';
      await sql`INSERT INTO company_users VALUES (${OWN3}::uuid, ${CREATOR}, 'owner')`;
      expect((await call('POST', CREATOR, { action: 'add-member', groupId: G, companyId: OWN3 })).statusCode).toBe(403);
    });
  });
});
