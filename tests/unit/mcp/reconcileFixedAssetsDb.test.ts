/**
 * The real reconciliation, against a real database.
 *
 * The tool test mocks the service outright, so it proves nothing about whether
 * the SQL runs. That is the failure class that shipped three defects in one day
 * here: `yearEndService.closeFiscalYear` INSERTed two columns that exist in no
 * environment and its mocked-template tests passed throughout, because a
 * statement Postgres would reject has exactly the same shape as one it accepts.
 *
 * These tests execute every query the service issues, and construct the two
 * findings the endpoint exists to surface:
 *  - a cost account carrying a CREDIT balance (a loan account subtyped
 *    fixed_assets — R8.4m of them on Brightsphere), which must be FLAGGED and
 *    still counted, never dropped
 *  - a ledger that has depreciated an asset the register says was never
 *    depreciated, which is Brightsphere's R7,500 exactly
 *
 * DB-gated: skips (never fails) when no DB is reachable. Export DATABASE_URL or
 * these do not run at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { reconcileFixedAssetsTool } from '@/lib/mcp/tools/reconcileFixedAssets';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
const AS_AT = '2031-12-31';

function toolCtx(companyId: string): McpToolContext {
  return {
    userId: '33333333-3333-3333-3333-333333333333',
    companyId,
    scopes: ['read:reports'],
  } as unknown as McpToolContext;
}

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

async function addAccount(
  companyId: string, code: string, name: string, subtype: string,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                             account_subtype, normal_balance, is_active)
    VALUES (${companyId}::uuid, ${code}, ${name}, ${'asset'}, ${subtype}, ${'debit'}, ${false})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

/** Posts a balanced journal: `amount` debit on `accountId`, credit on `contraId`. */
async function postJournal(
  companyId: string, accountId: string, contraId: string, amount: number, number: string,
): Promise<void> {
  const entry = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
    VALUES (${companyId}::uuid, ${number}, ${'2031-01-31'}::date, ${'fixture'}, ${'manual'}, ${'posted'}, ${'33333333-3333-3333-3333-333333333333'})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = String(entry[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${id}::uuid, ${accountId}::uuid, ${amount}, 0, ${companyId}::uuid)
  `;
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${id}::uuid, ${contraId}::uuid, 0, ${amount}, ${companyId}::uuid)
  `;
}

async function addAsset(
  companyId: string, number: string, price: number, accDep: number,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                        useful_life_years, accumulated_depreciation, current_book_value, status)
    VALUES (${companyId}::uuid, ${number}, ${`A ${number}`}, ${'2030-01-01'}::date,
            ${price}, ${3}, ${accDep}, ${price - accDep}, ${'available'})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

async function inTx(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs GL accounts, journals and assets.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: 'probe', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx, async () => {
      const rows = (await sql`SELECT id FROM companies ORDER BY created_at LIMIT 1`) as Array<{ id: string }>;
      const companyId = String(rows[0]!.id);
      await als.run(
        { client, userId: 'probe', companyId, claims: {} } as unknown as AlsCtx,
        () => run(companyId),
      );
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('reconcile_fixed_assets — the real SQL against a real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('runs every query it issues and returns a sound envelope', async () => {
    await inTx(async (companyId) => {
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);
      expect(body.universeTotal).toBeUndefined();
      expect(typeof body.difference).toBe('number');
    });
  });

  it.skipIf(!reachable)('flags a CREDIT-balance fixed-asset account and still counts it', async () => {
    await inTx(async (companyId) => {
      const loan = await addAccount(companyId, 'RFA-LOAN', 'Loan Account', 'fixed_assets');
      const contra = await addAccount(companyId, 'RFA-CONTRA', 'Contra', 'accumulated_depreciation');
      // Credit the "cost" account — a loan drawn down, not an asset bought.
      await postJournal(companyId, contra, loan, 250000, 'RFA-J1');

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const item = body.rows.find((r: { account_code: string }) => r.account_code === 'RFA-LOAN');

      expect(item.normal_balance_violated).toBe(true);
      // Counted, not dropped: its balance is -250000, so it contributes +250000.
      expect(item.amount).toBeCloseTo(250000, 2);
      expect(body.contra_normal_balance_count).toBeGreaterThanOrEqual(1);
      // is_active is FALSE on both fixtures. A deactivated account with a live
      // balance is still on the balance sheet and must not be filtered out.
      expect(body.rows.some((r: { account_code: string }) => r.account_code === 'RFA-CONTRA')).toBe(true);
    });
  });

  it.skipIf(!reachable)('shows a ledger that depreciated an asset the register did not', async () => {
    await inTx(async (companyId) => {
      // Measured as a DELTA against whatever this database already holds. An
      // absolute assertion would pass or fail on seed data rather than on the
      // behaviour under test.
      const before = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));

      const cost = await addAccount(companyId, 'RFA-COST', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      // The ledger depreciates: DR cost side (kept inside the section so the
      // fixture journal balances), CR accumulated depreciation.
      await postJournal(companyId, cost, accDep, 7500, 'RFA-J2');
      // The register says nothing has been depreciated.
      await addAsset(companyId, 'RFA-A1', 15000, 0);

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);

      // Register gained R15,000 of cost and NO depreciation; the ledger gained
      // R7,500 of accumulated depreciation against it.
      expect(body.register_cost - before.register_cost).toBeCloseTo(15000, 2);
      expect(body.register_accumulated_depreciation - before.register_accumulated_depreciation)
        .toBeCloseTo(0, 2);
      expect(body.gl_accumulated_depreciation - before.gl_accumulated_depreciation)
        .toBeCloseTo(-7500, 2);

      // The decomposition accounts for the whole difference, before and after.
      expect(body.unexplainedDifference).toBeCloseTo(0, 2);
      const summed = body.rows.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
      expect(summed).toBeCloseTo(body.difference, 2);
      // And the asset itself is an item, so a reader can follow it.
      const asset = body.rows.find((r: { asset_number: string | null }) => r.asset_number === 'RFA-A1');
      expect(asset.amount).toBeCloseTo(15000, 2);
      expect(body.register_linkage_available).toBe(false);
    });
  });

  it.skipIf(!reachable)('serves the journal behind an account at detail full', async () => {
    await inTx(async (companyId) => {
      const cost = await addAccount(companyId, 'RFA-COST2', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-ACC2', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, cost, accDep, 1234.56, 'RFA-J3');

      const body = json(await reconcileFixedAssetsTool.handler(
        { as_at: AS_AT, detail: 'full' }, toolCtx(companyId),
      ));
      const doc = body.rows.find((r: { entry_number: string }) => r.entry_number === 'RFA-J3');

      expect(doc.source).toBe('manual');
      expect(doc.journal_entry_id).toBeTruthy();
      expect(Math.abs(doc.amount)).toBeCloseTo(1234.56, 2);
    });
  });
});
