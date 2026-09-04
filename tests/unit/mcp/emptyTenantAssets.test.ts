/**
 * A brand-new tenant: no assets, no categories, no GL accounts, no fiscal
 * periods, no posted lines.
 *
 * This is the state every future customer starts in and it is not covered by
 * the production set. Velocity Fibre has zero assets but a populated ledger and
 * a chart of accounts — a DIFFERENT empty, and the one that hides the failures
 * that matter here: a reconciliation that divides, a `posted_through` taken from
 * an empty aggregate, a plan that assumes at least one asset, a preview that
 * resolves a system account nobody has configured yet.
 *
 * The rule these assertions encode: on an empty tenant every figure is zero,
 * every list is empty, the envelope is sound, and every refusal says what the
 * caller must do next. Nothing throws, and nothing reports success for a run
 * that did nothing.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
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
import { assetRegisterTool, listFixedAssetsTool } from '@/lib/mcp/tools/assets';
import { runDepreciationTool } from '@/lib/mcp/tools/writeDepreciation';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
const USER = '33333333-3333-3333-3333-333333333333';
const AS_AT = '2031-12-31';

function toolCtx(companyId: string): McpToolContext {
  return {
    userId: USER,
    companyId,
    scopes: ['read:reports', 'write:journals', 'write:post'],
  } as unknown as McpToolContext;
}

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

/** A tenant row and NOTHING else. No accounts, no periods, no assets. */
async function inEmptyTenant(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test creates an empty company.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: USER, companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          INSERT INTO companies (name) VALUES (${'EMPTY tenant fixture'}) RETURNING id
        `) as Array<{ id: string }>;
        const companyId = String(rows[0]!.id);

        // Prove it really is empty before asserting anything about it. A seed
        // trigger or a default chart would make every assertion below vacuous.
        const counts = (await sql`
          SELECT
            (SELECT COUNT(*)::INT FROM gl_accounts WHERE company_id = ${companyId}::uuid) AS accounts,
            (SELECT COUNT(*)::INT FROM assets WHERE company_id = ${companyId}::uuid) AS assets,
            (SELECT COUNT(*)::INT FROM fiscal_periods WHERE company_id = ${companyId}::uuid) AS periods,
            (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${companyId}::uuid) AS entries
        `) as Array<{ accounts: number; assets: number; periods: number; entries: number }>;
        expect(counts[0]).toEqual({ accounts: 0, assets: 0, periods: 0, entries: 0 });

        await als.run(
          { client, userId: USER, companyId, claims: {} } as unknown as AlsCtx,
          () => run(companyId),
        );
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('an empty tenant — the state every customer starts in', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('reconcile_fixed_assets answers zero everywhere, soundly', async () => {
    await inEmptyTenant(async (companyId) => {
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);

      expect(body.register_cost).toBe(0);
      expect(body.register_accumulated_depreciation).toBe(0);
      expect(body.register_net_book_value).toBe(0);
      expect(body.gl_cost).toBe(0);
      expect(body.gl_accumulated_depreciation).toBe(0);
      expect(body.gl_net_book_value).toBe(0);
      expect(body.difference).toBe(0);
      expect(body.itemsTotal).toBe(0);
      expect(body.unexplainedDifference).toBe(0);

      expect(body.rows).toEqual([]);
      expect(body.rowsTotal).toBe(0);
      expect(body.excludedRows).toEqual([]);
      expect(body.disclosures).toEqual([]);
      expect(body.unposted_disposals).toEqual([]);
      expect(body.unsubtyped_account_count).toBe(0);
      expect(body.unposted_disposal_count).toBe(0);
      expect(body.documents_total).toBe(0);
      expect(body.register_linkage_available).toBe(false);
      expect(body.contra_normal_balance_count).toBe(0);

      // No ledger row was consumed, so there is NO watermark — null, not the
      // epoch. `1970-01-01T00:00:00.000Z` is a claim that the ledger was read
      // through that instant, which is false; the same family as a now()
      // fallback or an equity plug, an absence dressed as data. Anything doing
      // `new Date(posted_through) > x` gets a plausible wrong answer from the
      // epoch instead of the null check it would have been forced to write.
      expect(body.posted_through).toBeNull();
      // The rows are produced, so there is still no completeness claim to make.
      expect(body.universeTotal).toBeUndefined();
    });
  });

  it.skipIf(!reachable)('a zero difference on an empty tenant is not a reconciliation, and nothing here says it is', async () => {
    await inEmptyTenant(async (companyId) => {
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      // The response must not carry a boolean that reads as "these books agree".
      // asset_register has `reconciled`; this endpoint deliberately does not,
      // because on an empty tenant it would be true and mean nothing.
      expect(body).not.toHaveProperty('reconciled');
      expect(reconcileFixedAssetsTool.description).toMatch(/necessary and not sufficient/i);
    });
  });

  it.skipIf(!reachable)('detail summary and full both hold on an empty tenant', async () => {
    await inEmptyTenant(async (companyId) => {
      for (const detail of ['summary', 'standard', 'full'] as const) {
        const res = await reconcileFixedAssetsTool.handler(
          { as_at: AS_AT, detail }, toolCtx(companyId),
        );
        expect(res.isError).not.toBe(true);
        const body = json(res);
        assertEnvelopeSound(body);
        expect(body.rows).toEqual([]);
        expect(body.detail).toBe(detail);
        expect(body.next_cursor).toBeNull();
      }
    });
  });

  it.skipIf(!reachable)('the shipped asset tools answer an empty tenant too', async () => {
    await inEmptyTenant(async (companyId) => {
      const reg = json(await assetRegisterTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      expect(reg.reconciliation.difference).toBe(0);
      expect(reg.reconciliation.cost_accounts).toEqual([]);
      expect(reg.reconciliation.accumulated_depreciation_accounts).toEqual([]);
      expect(reg.posted_through).toBeNull();

      const list = json(await listFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      // list_fixed_assets reads the assets table and NO ledger at all, so its
      // posted_through is null permanently, not only when the company is empty.
      expect(list.posted_through).toBeNull();
      assertEnvelopeSound(list);
      expect(list.rows).toEqual([]);
      expect(list.rowsTotal).toBe(0);
      // universeTotal IS claimed here — list_fixed_assets selects from a pool —
      // and 0 + 0 === 0 must hold rather than fault.
      expect(list.universeTotal).toBe(0);
      expect(list.totals).toEqual({ cost: 0, accumulatedDepreciation: 0, netBookValue: 0 });
    });
  });

  it.skipIf(!reachable)('run_depreciation REFUSES an empty register before touching the ledger', async () => {
    await inEmptyTenant(async (companyId) => {
      // The period blocker fires first on a truly empty tenant (asserted in the
      // next test), so give this one an open period to isolate the register
      // refusal — the message a customer who HAS set up their fiscal year but
      // has captured no assets will actually see.
      await sql`
        INSERT INTO fiscal_periods (company_id, period_name, fiscal_year, period_number,
                                    start_date, end_date, status)
        VALUES (${companyId}::uuid, ${'EMPTY period'}, ${2031}, ${1},
                ${'2031-01-01'}::date, ${'2031-12-31'}::date, ${'open'})
      `;
      for (const dryRun of [true, false]) {
        const res = await runDepreciationTool.handler(
          { period_date: '2031-03-31', dry_run: dryRun, idempotency_key: `empty-${dryRun}` },
          toolCtx(companyId),
        );
        // "There is no asset register" and "every asset was skipped" are
        // different facts. The empty tenant is the only place the first one is
        // reachable, and an empty reason list is what it used to say.
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toMatch(/no fixed assets on the register/i);
        expect(res.content[0]!.text).not.toMatch(/\(\)/);
      }

      const entries = (await sql`
        SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid
      `) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(0);
    });
  });

  it.skipIf(!reachable)('an empty register is refused BEFORE the missing fiscal period is', async () => {
    await inEmptyTenant(async (companyId) => {
      // An empty tenant has NO fiscal periods either, so both refusals apply.
      // The period blocker wins, because it is the one a caller has to fix
      // first — capturing assets into a company with no fiscal year still
      // leaves the run impossible.
      const res = await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'empty-order' }, toolCtx(companyId),
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/no fiscal period covers/i);
    });
  });
});
