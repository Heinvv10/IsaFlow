/**
 * The stock valuation, against real tables.
 *
 * Every reference to this service in `tests/` mocked the function outright, so
 * `INBOUND_MOVEMENT_TYPES`, the join boundary, the orphan query and the
 * value/quantity/averageCost arithmetic had never executed in CI — while the
 * file's own docblock treats all four as load-bearing. Untested arithmetic in a
 * valuation is the thing this programme exists to stop shipping.
 *
 * Everything runs inside BEGIN … ROLLBACK on an ALS-bound client, so the
 * fixtures below never persist. All 240 production movements are `purchase` at
 * total_cost 0, so the interesting cases have to be built rather than found.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { getStockValuation } from '@/modules/accounting/services/items/stockValuationService';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string): AlsCtx {
  return { client, userId: 'probe', companyId, claims: {} } as unknown as AlsCtx;
}

const AS_OF = '2031-12-31';

async function newCompany(): Promise<string> {
  const rows = (await sql`SELECT id FROM companies ORDER BY created_at LIMIT 1`) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

/** A product with no movements yet — the LEFT JOIN case. */
async function addProduct(companyId: string | null, code: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO products (company_id, code, name, unit)
    VALUES (${companyId}::uuid, ${code}, ${`P ${code}`}, ${'each'})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

async function addMovement(
  productId: string,
  type: string,
  quantity: number,
  totalCost: number | null,
  createdAt = '2031-06-01T00:00:00Z',
): Promise<void> {
  await sql`
    INSERT INTO stock_movements (product_id, movement_type, quantity, total_cost, created_at)
    VALUES (${productId}::uuid, ${type}, ${quantity}, ${totalCost}, ${createdAt}::timestamptz)
  `;
}

async function inTx(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs products and stock movements.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(alsCtx(client, 'bootstrap'), async () => {
      const companyId = await newCompany();
      await als.run(alsCtx(client, companyId), () => run(companyId));
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('getStockValuation against real products and stock_movements', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('adds inbound movements and subtracts outbound ones', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-IO');
      await addMovement(p, 'purchase', 100, 1000);
      await addMovement(p, 'sale', 30, 300);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-IO')!;
      expect(row.quantityOnHand).toBe(70);
      expect(row.value).toBe(700);
      expect(row.averageCost).toBe(10);
      expect(row.movementCount).toBe(2);
      expect(row.unvalued).toBe(false);
    });
  });

  // 'grn' is a goods-received note: inbound by any reading, and permitted by the
  // movement_type CHECK. It was outbound by omission, so a GRN would have
  // SUBTRACTED received stock with nothing to flag it.
  it.skipIf(!reachable)('treats a goods-received note as inbound', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-GRN');
      await addMovement(p, 'grn', 40, 400);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-GRN')!;
      expect(row.quantityOnHand).toBe(40);
      expect(row.value).toBe(400);
    });
  });

  // A stocktake 'count' is an absolute, not a delta. Treating it as outbound
  // subtracted the counted quantity; treating it as inbound would double it.
  // It is neither, and must be named rather than silently dropped.
  it.skipIf(!reachable)('excludes a stocktake count from the delta instead of subtracting it', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-CNT');
      await addMovement(p, 'purchase', 50, 500);
      await addMovement(p, 'count', 50, 0);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-CNT')!;
      expect(row.quantityOnHand).toBe(50);
      expect(v.excluded.some(e => e.reason === 'stocktake_count_not_a_delta')).toBe(true);
    });
  });

  it.skipIf(!reachable)('shows a product with no movements at zero rather than dropping it', async () => {
    await inTx(async (companyId) => {
      await addProduct(companyId, 'SV-NONE');
      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-NONE')!;
      expect(row).toBeDefined();
      expect(row.quantityOnHand).toBe(0);
      expect(row.averageCost).toBeNull();
      expect(row.movementCount).toBe(0);
    });
  });

  // The as-of bound lives in the LEFT JOIN's ON clause ON PURPOSE: in WHERE it
  // would drop the product entirely instead of showing it at zero.
  it.skipIf(!reachable)('ignores movements after the as-of date, keeping the product', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-LATE');
      await addMovement(p, 'purchase', 10, 100, '2032-06-01T00:00:00Z');

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-LATE')!;
      expect(row).toBeDefined();
      expect(row.quantityOnHand).toBe(0);
      expect(row.movementCount).toBe(0);
    });
  });

  it.skipIf(!reachable)('never returns another company\'s product', async () => {
    await inTx(async (companyId) => {
      const others = (await sql`
        SELECT id FROM companies WHERE id <> ${companyId}::uuid ORDER BY created_at LIMIT 1
      `) as Array<{ id: string }>;
      const otherId = String(others[0]!.id);
      await addProduct(otherId, 'SV-OTHER');

      const v = await getStockValuation(companyId, AS_OF);
      expect(v.rows.some(r => r.code === 'SV-OTHER')).toBe(false);
    });
  });

  // A product with a NULL company_id belongs to no tenant. Its movements must
  // not reach this company's figures, AND the disclosure must not carry a count
  // or a value: those are drawn from rows that may belong to other tenants.
  it.skipIf(!reachable)('discloses unattributable movements without quantifying them', async () => {
    await inTx(async (companyId) => {
      const orphan = await addProduct(null, 'SV-ORPHAN');
      await addMovement(orphan, 'purchase', 999, 99999);

      const v = await getStockValuation(companyId, AS_OF);
      expect(v.rows.some(r => r.code === 'SV-ORPHAN')).toBe(false);
      expect(v.totalValue).not.toBe(99999);

      const note = v.excluded.find(e => e.reason === 'product_has_no_company');
      expect(note).toBeDefined();
      // No count, no value — disclosure must not leak other tenants' data.
      expect(note!.amount).toBeUndefined();
      expect(note!.detail ?? '').not.toMatch(/\d/);
    });
  });

  // The universe is THIS company's products. Unattributable movements are not
  // among them, so they must not inflate it.
  it.skipIf(!reachable)('counts only this company\'s products in the universe', async () => {
    await inTx(async (companyId) => {
      const orphan = await addProduct(null, 'SV-ORPHAN2');
      await addMovement(orphan, 'purchase', 5, 50);
      await addProduct(companyId, 'SV-MINE');

      const v = await getStockValuation(companyId, AS_OF);
      expect(v.universeTotal).toBe(v.rowsTotal);
    });
  });

  it.skipIf(!reachable)('reports stock received but never valued, rather than R0 as a valuation', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-UNVAL');
      await addMovement(p, 'purchase', 25, 0);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-UNVAL')!;
      expect(row.quantityOnHand).toBe(25);
      expect(row.value).toBe(0);
      expect(row.unvalued).toBe(true);
      expect(v.unvaluedProductCount).toBeGreaterThan(0);
    });
  });

  // NULL total_cost is permitted by the schema. Summed raw it makes the whole
  // product's value NULL; it must read as zero cost recorded.
  it.skipIf(!reachable)('treats a NULL total_cost as no cost recorded, not as a NULL value', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-NULLCOST');
      await addMovement(p, 'purchase', 10, null);
      await addMovement(p, 'purchase', 10, 250);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-NULLCOST')!;
      expect(row.quantityOnHand).toBe(20);
      expect(row.value).toBe(250);
      expect(Number.isNaN(row.value)).toBe(false);
    });
  });

  // Outbound exceeding inbound is a data fault, not a negative valuation.
  it.skipIf(!reachable)('refuses to report a negative average cost', async () => {
    await inTx(async (companyId) => {
      const p = await addProduct(companyId, 'SV-NEG');
      await addMovement(p, 'sale', 10, 100);

      const v = await getStockValuation(companyId, AS_OF);
      const row = v.rows.find(r => r.code === 'SV-NEG')!;
      expect(row.quantityOnHand).toBe(-10);
      expect(row.averageCost).toBeNull();
    });
  });
});
