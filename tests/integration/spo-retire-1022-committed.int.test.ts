/**
 * Migration 1022 and committed spend (PR #1703: the breaker's repro, then Hein's ruling that copies keep their unbilled
 * remainder in committed), real PostgreSQL 16 and the real budgets/remainingCommitted.readCommitments. A legacy bill can name a
 * legacy order only by its header; committed now nets header billing (budgets/remainingHeaderBilled), so nothing counts twice:
 *   A  received, fully billed by an approved header bill          -> closed, commits 0
 *   B1 partially_invoiced, R400 of R1000 billed (approved bill)    -> open (received), commits the R600 remainder exactly
 *   B2 the same order, its bill lost                               -> open, commits R1000 (nothing to net)
 *   B3 partially_invoiced whose only bill is a draft               -> open, commits R1000 (a draft nets nothing)
 *   C  sent, over-billed by a PAID R1500 bill                      -> closed, commits 0
 *   D  sent: a 12345.6789 x 1.23 line and a 0.125 one              -> commits its R15 186.43 (the big line as 1 unit)
 *   E  sent: R500 and a 0.004-quantity dust line                   -> commits R500.04 (the dust line copied, not lost)
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedRawBill } from './helpers/poBillLinkHarness';
import { asBeforeRetirement, dropCanonical, dropLegacy, runMigration, seedSpo, type SeededSpo } from './spo-retire-1022.helpers';
import { readCommitments } from '@/modules/accounting/services/budgets/remainingCommitted';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
const S: Record<string, SeededSpo> = {};

beforeAll(async () => {
  f = await seedBillFixture(pool, 'spo-committed');
  const gl = f.acc.opex;
  const ten = (received: number, invoiced: number) => [{ qty: 10, price: 100, received, invoiced, gl }];
  await asBeforeRetirement(pool, async (c) => {
    const at = async (k: string, status: string, lines: Parameters<typeof seedSpo>[1]['lines']) => {
      S[k] = await seedSpo(c, { co: f.co, supplier: f.supplier, number: `CM-${k}`, status, lines });
    };
    await at('A', 'received', ten(10, 10));
    await at('B1', 'partially_invoiced', ten(10, 4));
    await at('B2', 'partially_invoiced', ten(10, 4));
    await at('B3', 'partially_invoiced', ten(10, 9));
    await at('C', 'sent', ten(0, 0));
    await at('D', 'sent', [{ qty: 12345.6789, price: 1.23, lineTotal: 15185.18, gl }, { qty: 0.125, price: 9.99, lineTotal: 1.25, gl }]);
    await at('E', 'sent', [{ qty: 1, price: 500, gl }, { qty: 0.004, price: 10, lineTotal: 0.04, gl }]);
  });
  const bill = (k: string, total: number, status: string) =>
    seedRawBill(pool, f, { items: [{ total }], subtotal: total, total: Math.round(total * 115) / 100, header: S[k]!.id, status });
  await bill('A', 1000, 'approved');
  await bill('B1', 400, 'approved');
  await bill('B3', 1, 'draft');
  await bill('C', 1500, 'paid');
  await runMigration(pool);
}, 120_000);

afterAll(async () => {
  try {
    if (f) { await dropLegacy(pool, [f.co]); await dropCanonical(pool, [f.co]); }
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const committedByOrder = async (): Promise<Record<string, number>> => {
  const rows = await readCommitments(f.co, [f.acc.opex], '2026-05-01', '2026-05-31', {});
  const owner = new Map((await pool.query(`SELECT i.id::TEXT AS id, po.po_number FROM po_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
    WHERE po.company_id = $1`, [f.co])).rows.map((r) => [String(r.id), String(r.po_number)]));
  const out: Record<string, number> = {};
  for (const r of rows) { const n = owner.get(r.poItemId)!; out[n] = (out[n] ?? 0) + openPoLineCents(r.lineTotal, r.billed); }
  return out;
};

describe('committed spend after the copy', () => {
  it('commits each copy\'s unbilled remainder exactly: nothing for a fully billed one, all of an unbilled one', async () => {
    expect(await committedByOrder()).toEqual({ 'CM-B1': 60000, 'CM-B2': 100000, 'CM-B3': 100000, 'CM-D': 1518643, 'CM-E': 50004 });
  });

  it('closes only the fully billed copies, from their open status', async () => {
    const st = async (k: string) => (await pool.query('SELECT status, closed_from_status FROM purchase_orders WHERE id = $1', [S[k]!.id])).rows[0];
    expect(await st('A')).toEqual({ status: 'closed', closed_from_status: 'received' });
    expect(await st('B1')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('B2')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('B3')).toEqual({ status: 'received', closed_from_status: null });
    expect(await st('C')).toEqual({ status: 'closed', closed_from_status: 'approved' });
    expect(await st('D')).toEqual({ status: 'approved', closed_from_status: null });
  });
});
