/**
 * Budgets P3 PR-B (T10, spec §2.6), on real PostgreSQL: the Budget vs Actual
 * drill foots. For every filter the page can set (none, CC1, CC2, BU, CC1 + BU,
 * CC2 + BU), each line's drill `periodNet` (getAccountTransactions with the
 * explicit levels the route forwards) equals the line's Actual, to the cent.
 * A transaction posted from a document carries that document, so the drill can
 * link to it. Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import type { TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

type Filter = { cc1Id?: string; cc2Id?: string; buId?: string };
const filters = (): Array<[string, Filter]> => [
  ['none', {}], ['cc1', { cc1Id: f.cc.FT }], ['cc2', { cc2Id: f.cc.P1 }], ['bu', { buId: f.bu.B1 }],
  ['cc1+bu', { cc1Id: f.cc.FT, buId: f.bu.B1 }], ['cc2+bu', { cc2Id: f.cc.P1, buId: f.bu.B1 }],
];
const WINDOWS: TrackingParams[] = [{ period: 'fy', fiscalYear: 2027 }, { period: 'quarter', fiscalYear: 2027, quarter: 2 }];

describe('the drill foots to the Budget vs Actual line', () => {
  for (const w of WINDOWS) {
    it(`${JSON.stringify(w)}: Σ drill periodNet = Actual for every line and filter`, async () => {
      const bad: string[] = [];
      let compared = 0;
      for (const [name, flt] of filters()) {
        await asRequest(pool, f.a, f.userA, async () => {
          const r = await buildBudgetTrackingReport(f.a, { ...w, ...flt }, NOW);
          for (const l of r.lines) {
            const d = await getAccountTransactions(f.a, l.accountCode, r.window.startDate, r.window.endDate, undefined, flt.buId,
              { cc1Id: flt.cc1Id, cc2Id: flt.cc2Id });
            compared++;
            if (Math.round(d.periodNet * 100) !== Math.round(l.actual * 100)) bad.push(`${name} ${l.accountCode}: drill ${d.periodNet}, line ${l.actual}`);
          }
        });
      }
      expect(bad).toEqual([]);
      expect(compared).toBeGreaterThan(12);
    });
  }

  it('a transaction posted from a customer invoice carries that invoice; a manual one carries none', async () => {
    const inv = crypto.randomUUID();
    const d = await asRequest(pool, f.a, f.userA, () => getAccountTransactions(f.a, 'BT-4000', '2026-03-01', '2026-03-31', undefined, undefined, {}), {
      before: async (c) => {
        const { rows } = await c.query(`SELECT je.id FROM gl_journal_entries je WHERE je.company_id = $1 AND je.entry_date = '2026-03-15' AND je.status = 'posted'`, [f.a]);
        const cust = crypto.randomUUID();
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'BT Customer')`, [cust, f.a]);
        await c.query(`INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, created_by, gl_journal_entry_id) VALUES ($1, $2, 'BT-INV-1', $3, $3, $4, $5)`,
          [inv, f.a, cust, f.userA, rows[0].id]);
        await c.query('SET LOCAL session_replication_role = origin');
      },
    });
    const posted = d.transactions.filter((t) => !t.derived);
    expect(posted.length).toBeGreaterThan(0);
    const mid = posted.filter((t) => t.date === '2026-03-15');
    expect(mid.length).toBeGreaterThan(0);
    for (const t of mid) expect(t.document).toEqual({ kind: 'customer_invoice', id: inv });
    for (const t of posted.filter((x) => x.date !== '2026-03-15')) expect(t.document).toBeNull();
    for (const t of posted) expect(t.journalId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
