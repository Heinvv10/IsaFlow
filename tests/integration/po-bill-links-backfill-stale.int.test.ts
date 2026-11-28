/**
 * The stale link beside a re-pointed header (design note, M1), real PostgreSQL: migration 1032's remainder rule gives the header PO only what is
 * unlinked, never a second full amount. Runs the 1032 definition (read from the file, not from whatever an earlier suite left in the shared
 * database) and the design note's count query inside a transaction that is rolled back. Sibling of po-bill-links-backfill-rerun.int.test.ts.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { seedPo, seedRawBill } from './helpers/poBillLinkHarness';
import { INSTALL } from './helpers/backfillRerunMigration';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

describe('the header PO gets the remainder beside a stale link, never a second full amount', () => {
  let m: BillFixture;
  beforeAll(async () => { m = await seedBillFixture(pool, 'po-bf-rerun-stale'); }, 60_000);
  afterAll(async () => { try { await dropBillFixture(pool, m); } finally { await pool.end(); } }, 60_000);
  const sql = () => /```sql\n([\s\S]*?)```/.exec(readFileSync(join(process.cwd(), 'docs/design/po-bill-links-backfill.md'), 'utf8'))?.[1]?.replace(/;\s*$/, '');

  it('stale 100.00 on A, header B: no link to B (the bill stays at its subtotal); stale 30.00: B gets 70.00; a plain header-only bill is linked; a second run writes 0', async () => {
    const poA = await seedPo(pool, m, { lines: [100] });
    const poB = await seedPo(pool, m, { lines: [100] });
    const poC = await seedPo(pool, m, { lines: [100] });
    const poD = await seedPo(pool, m, { lines: [100] });
    const poE = await seedPo(pool, m, { lines: [100] });
    const full = await seedRawBill(pool, m, { items: [{ total: 100 }], subtotal: 100, total: 115, header: poB.po });
    const part = await seedRawBill(pool, m, { items: [{ total: 100 }], subtotal: 100, total: 115, header: poD.po });
    const plain = await seedRawBill(pool, m, { items: [{ total: 100 }], subtotal: 100, total: 115, header: poE.po });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(INSTALL);
      // The stale links: written by an earlier backfill while the headers named A / C, then re-pointed to B / D outside the app.
      for (const [po, bill, amount] of [[poA.po, full.id, 100], [poC.po, part.id, 30]] as const) {
        await c.query(`INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, $4, 'backfill')`, [m.co, po, bill, amount]);
      }
      const q = sql();
      expect(q, 'the design note carries the count query').toBeDefined();
      const count = async () => (await c.query(`SELECT * FROM (${q!}) q WHERE q.company_id = $1`, [m.co])).rows;
      expect(await count(), 'the note\'s query finds both bills before the run').toEqual([{ company_id: m.co, bills: '2' }]);
      const links = async () => (await c.query('SELECT supplier_invoice_id AS bill, purchase_order_id AS po, amount::TEXT AS amount FROM purchase_order_bill_links WHERE company_id = $1 ORDER BY 1, 2', [m.co])).rows;
      await c.query('SELECT purchase_order_bill_links_backfill($1)', [m.co]);
      const after = await links();
      const of = (bill: string) => after.filter((l) => l.bill === bill).map((l) => [l.po, l.amount]).sort();
      expect(of(full.id)).toEqual([[poA.po, '100.00']]);
      expect(of(part.id)).toEqual([[poC.po, '30.00'], [poD.po, '70.00']].sort());
      expect(of(plain.id)).toEqual([[poE.po, '100.00']]);
      for (const bill of [full, part, plain]) expect(after.filter((l) => l.bill === bill.id).reduce((t, l) => t + Number(l.amount), 0)).toBeLessThanOrEqual(100);
      expect((await c.query('SELECT purchase_order_bill_links_backfill($1) AS n', [m.co])).rows[0].n).toBe('0');
      expect(await links()).toEqual(after);
      // The query lists bills whose header PO has no link yet and which hold an owned link elsewhere: `full` still (it was left unlinked on purpose), `part` no longer.
      expect((await count()).map((r) => r.bills)).toEqual(['1']);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  }, 60_000);
});
