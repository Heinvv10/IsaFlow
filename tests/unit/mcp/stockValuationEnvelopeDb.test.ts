/**
 * The real valuation through the real envelope.
 *
 * The service and the envelope were each covered on their own, and the tool
 * test mocked `getStockValuation` outright — so nothing ran the two together.
 * That is exactly where the regression lived: `universeTotal` was narrowed to
 * this company's products (correct) while the disclosures were still handed to
 * `buildEnvelope` as `excludedRows` (not corrected), and the identity
 * `rowsTotal + excludedRows.length === universeTotal` then failed the moment a
 * stocktake count or a cross-tenant orphan existed — emitting a
 * completenessFault whose cause was a DISCLOSURE, not a lost row.
 *
 * Dormant in production only because there are no `count` movements and no
 * orphan products today. This test creates both.
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
import { stockValuationTool } from '@/lib/mcp/tools/inventoryAndAp';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
const AS_OF = '2031-12-31';

function toolCtx(companyId: string): McpToolContext {
  return {
    userId: '33333333-3333-3333-3333-333333333333',
    companyId,
    scopes: ['read:reports'],
  } as unknown as McpToolContext;
}

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

async function addProduct(companyId: string | null, code: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO products (company_id, code, name, unit)
    VALUES (${companyId}::uuid, ${code}, ${`P ${code}`}, ${'each'})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

async function addMovement(productId: string, type: string, qty: number, cost: number): Promise<void> {
  await sql`
    INSERT INTO stock_movements (product_id, movement_type, quantity, total_cost, created_at)
    VALUES (${productId}::uuid, ${type}, ${qty}, ${cost}, ${'2031-06-01T00:00:00Z'}::timestamptz)
  `;
}

async function inTx(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs products and stock movements.');
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

describe('stock_valuation — real service through the real envelope', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('raises no completenessFault with a stocktake count present', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SVE-CNT');
      await addMovement(p, 'purchase', 50, 500);
      await addMovement(p, 'count', 50, 0);

      const body = json(await stockValuationTool.handler({ as_at: AS_OF }, toolCtx(companyId)));

      expect(body.completenessFault).toBeUndefined();
      expect(body.excludedRows).toHaveLength(0);
      expect(body.disclosures.some(
        (d: { reason: string }) => d.reason === 'stocktake_count_not_a_delta',
      )).toBe(true);
    });
  });

  it.skipIf(!reachable)('raises no completenessFault with an unattributable movement present', async () => {
    await inTx(async (companyId) => {
      await addProduct(companyId, 'SVE-MINE');
      const orphan = await addProduct(null, 'SVE-ORPHAN');
      await addMovement(orphan, 'purchase', 999, 99999);

      const body = json(await stockValuationTool.handler({ as_at: AS_OF }, toolCtx(companyId)));

      expect(body.completenessFault).toBeUndefined();
      const note = body.disclosures.find(
        (d: { reason: string }) => d.reason === 'product_has_no_company',
      );
      expect(note).toBeDefined();
      expect(note.amount).toBeUndefined();
      expect(String(note.detail ?? '')).not.toMatch(/\d/);
      expect(body.total_value).not.toBe(99999);
    });
  });

  it.skipIf(!reachable)('the identity holds with both disclosures at once', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SVE-BOTH');
      await addMovement(p, 'purchase', 10, 100);
      await addMovement(p, 'count', 10, 0);
      const orphan = await addProduct(null, 'SVE-ORPHAN2');
      await addMovement(orphan, 'purchase', 5, 50);

      const body = json(await stockValuationTool.handler({ as_at: AS_OF }, toolCtx(companyId)));

      expect(body.completenessFault).toBeUndefined();
      expect(body.disclosures).toHaveLength(2);
      // rowsTotal alone accounts for the universe: the disclosures are facts
      // about data OUTSIDE it, not rows withheld from within it.
      expect(body.rowsTotal).toBe(body.rows.length);
    });
  });
});
