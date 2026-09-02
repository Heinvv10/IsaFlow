/**
 * `reclassifyAccount` — proven against a real Postgres.
 *
 * The gap it closes: `account_subtype` and `parent_account_id` were writable
 * ONLY by `createAccount`. 27 Velocity Fibre paycards carried a NULL subtype,
 * which made them invisible to `getBankAccountsStatus` (it filters
 * `account_subtype = 'bank'`) and therefore unable to receive a statement
 * import at all — with no edit path anywhere in the product, the only remedy
 * was to recreate every one of them under a new code.
 *
 * Mocking `sql` here would prove nothing that matters: every guard in this
 * service is a query. The recursive descendant walk, the level cascade and the
 * leaf rule are SQL behaviours, so they are exercised as SQL.
 *
 * This test WRITES, so it refuses to run against the production database. All
 * of it happens inside one transaction that is rolled back.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import {
  reclassifyAccount,
  ReclassifyError,
} from '@/modules/accounting/services/gl/accountReclassifyService';

type Ctx = Parameters<typeof als.run>[0];
const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const PREFIX = 'ZZTESTRECLASS';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

/** A company with at least one GL account, so the tenant fence has something real to bite on. */
async function findCompany(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ company_id: string }>(
    `SELECT company_id FROM gl_accounts GROUP BY company_id ORDER BY company_id LIMIT 1`,
  );
  return rows[0]?.company_id ?? null;
}

async function makeAccount(
  client: PoolClient,
  companyId: string,
  code: string,
  opts: { type?: string; subtype?: string | null; parentId?: string | null; level?: number } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts
       (company_id, account_code, account_name, account_type, account_subtype,
        parent_account_id, normal_balance, level, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, 'debit', $7, true)
     RETURNING id`,
    [
      companyId, `${PREFIX}${code}`, `${PREFIX} ${code}`,
      opts.type ?? 'asset', opts.subtype ?? null, opts.parentId ?? null, opts.level ?? 1,
    ],
  );
  return rows[0]!.id;
}

async function readAccount(client: PoolClient, id: string) {
  const { rows } = await client.query<{
    account_subtype: string | null; parent_account_id: string | null; level: number;
  }>('SELECT account_subtype, parent_account_id, level FROM gl_accounts WHERE id = $1', [id]);
  return rows[0]!;
}

describe('reclassifyAccount', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('sets a NULL subtype to bank — the paycard case', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      const paycard = await makeAccount(client, companyId, '1001', { subtype: null });

      await als.run(ctxFor(client, companyId), () =>
        reclassifyAccount(companyId, paycard, { accountSubtype: 'bank' }));

      expect((await readAccount(client, paycard)).account_subtype).toBe('bank');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it.skipIf(!reachable)('reparents, and cascades the level to the whole subtree', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      // umbrella(level 1) ; moved(level 1) -> child(level 2) -> grandchild(3)
      const umbrella = await makeAccount(client, companyId, '2000', { subtype: 'bank' });
      const moved = await makeAccount(client, companyId, '2001');
      const child = await makeAccount(client, companyId, '2002', { parentId: moved, level: 2 });
      const grandchild = await makeAccount(client, companyId, '2003', { parentId: child, level: 3 });

      await als.run(ctxFor(client, companyId), () =>
        reclassifyAccount(companyId, moved, { parentAccountId: umbrella }));

      // Descendants shift by the same delta. Without the cascade they keep the
      // depth they had under the old parent, and `level` is what several
      // reports group on.
      expect(await readAccount(client, moved)).toMatchObject({ parent_account_id: umbrella, level: 2 });
      expect((await readAccount(client, child)).level).toBe(3);
      expect((await readAccount(client, grandchild)).level).toBe(4);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it.skipIf(!reachable)('refuses a cycle, self-parenting, and a cross-type parent', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      const parent = await makeAccount(client, companyId, '3000');
      const kid = await makeAccount(client, companyId, '3001', { parentId: parent, level: 2 });
      const expense = await makeAccount(client, companyId, '3002', { type: 'expense' });

      await als.run(ctxFor(client, companyId), async () => {
        // A cycle would make the recursive level UPDATE and the account tree
        // non-terminating.
        await expect(reclassifyAccount(companyId, parent, { parentAccountId: kid }))
          .rejects.toThrow(/cycle/i);
        await expect(reclassifyAccount(companyId, parent, { parentAccountId: parent }))
          .rejects.toThrow(/its own parent/i);
        await expect(reclassifyAccount(companyId, parent, { parentAccountId: expense }))
          .rejects.toThrow(/expense account/i);
      });

      // Refused before writing: the row is untouched by all three.
      expect((await readAccount(client, parent)).parent_account_id).toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it.skipIf(!reachable)('refuses a parent that already carries postings (migration 484\'s rule)', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      // A real posted account in this company — the balance sheet excludes
      // parent headers, so giving one a child silently removes its own balance
      // from the statements.
      const { rows: posted } = await client.query<{ gl_account_id: string }>(
        `SELECT gl_account_id FROM gl_journal_lines
          WHERE company_id = $1 AND gl_account_id IS NOT NULL LIMIT 1`,
        [companyId],
      );
      if (!posted[0]) { ctx.skip('no posted journal lines in this company'); return; }
      const postedId = posted[0].gl_account_id;

      const { rows: typeRows } = await client.query<{ account_type: string }>(
        'SELECT account_type FROM gl_accounts WHERE id = $1', [postedId],
      );
      const orphan = await makeAccount(client, companyId, '4000', { type: typeRows[0]!.account_type });

      await als.run(ctxFor(client, companyId), async () => {
        await expect(reclassifyAccount(companyId, orphan, { parentAccountId: postedId }))
          .rejects.toThrow(/balance sheet excludes headers/);
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it.skipIf(!reachable)('will not strip the bank subtype while transactions still point at the account', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts and bank transactions.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      const bank = await makeAccount(client, companyId, '5000', { subtype: 'bank' });
      await client.query(
        `INSERT INTO bank_transactions
           (company_id, bank_account_id, transaction_date, amount, description, status)
         VALUES ($1, $2, CURRENT_DATE, -1.00, $3, 'imported')`,
        [companyId, bank, `${PREFIX} tx`],
      );

      await als.run(ctxFor(client, companyId), async () => {
        // The rows would still exist and be reachable from nothing: every
        // banking screen finds them via account_subtype = 'bank'.
        await expect(reclassifyAccount(companyId, bank, { accountSubtype: null }))
          .rejects.toThrow(/bank transaction/i);
      });
      expect((await readAccount(client, bank)).account_subtype).toBe('bank');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it.skipIf(!reachable)('is fenced to the company, and refuses reserved and mistyped subtypes', async (ctx) => {
    assertNotProductionDb('This test inserts GL accounts.');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const companyId = await findCompany(client);
      if (!companyId) { ctx.skip('no company with GL accounts'); return; }

      const account = await makeAccount(client, companyId, '6000');
      const otherCompany = '00000000-0000-4000-8000-00000000dead';

      await als.run(ctxFor(client, companyId), async () => {
        // Same text as a genuine miss — a distinct reply would be a
        // cross-tenant existence oracle.
        await expect(reclassifyAccount(otherCompany, account, { accountSubtype: 'bank' }))
          .rejects.toThrow(new ReclassifyError('Account not found'));

        // Reserved: systemAccountResolver keys on this name and its cache has
        // no uniqueness guard, so a second claimant silently displaces the first.
        await expect(reclassifyAccount(companyId, account, { accountSubtype: 'vat_input' as never }))
          .rejects.toThrow(/reserved/i);

        // Wrong for the TYPE: 'payable' is a liability subtype.
        await expect(reclassifyAccount(companyId, account, { accountSubtype: 'payable' as never }))
          .rejects.toThrow(/not valid for an asset account/);

        await expect(reclassifyAccount(companyId, account, {}))
          .rejects.toThrow(/Nothing to reclassify/);
      });

      expect((await readAccount(client, account)).account_subtype).toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
