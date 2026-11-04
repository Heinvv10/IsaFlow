/**
 * Budgets P5-2b (breaker round 2; coordinator's ruling, 2026-11-04): a CAPTURE bill whose slip will evidence a
 * bank-first provisional takes the provisional's dimensions when its lines are planned and written
 * (`captureBillLines.planCaptureBillLines`, the provisional `findAttachableProvisional` matches), ahead of the
 * supplier's default; with no unambiguous match, the supplier default. Breaker 10b: a supplier default that resolves
 * to a dimension refusal is a plan refusal, as on REST. Real PostgreSQL as app_user. Fixture: opex BB-6100 at CC1
 * FT 1 000 / HT 0 a month (FY2027); supplier S2 defaults CC1 to HT. Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { insertCaptureBillLines, planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { billLineCc1, postedOpexBySlice, seedUnevidencedProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
const S2 = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-capture-slip');
  await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S2 defaults HT', true)", [S2, f.co]);
  await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc1_id) VALUES ($1, $2, $3)', [f.co, S2, f.cc.HT]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM supplier_coding_rules WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try { const out = await r.run(fn); await r.commit(); return out; } finally { await r.rollback(); }
}
const plan = (supplierId: string, date: string, total = 920, tax = 120) => planCaptureBillLines(f.co, {
  supplierId, invoiceNumber: 'X', invoiceDate: date, totalAmount: total, taxAmount: tax, taxRate: 15, items: [],
} as never, 0, f.acc.opex, null);

describe('capture: the slip\'s centre wins over the supplier default', () => {
  it('auto-approved capture: planned on FT (the provisional), not HT (S2 default); attached, posted on FT, settled (block)', async () => {
    await setPolicy(pool, f, 'block');
    await seedUnevidencedProvisional(pool, f, '2026-04-10', [{ amount: 800, cc1: f.cc.FT }], S2);
    const doc = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
    const bill = await makeBill(pool, f, [], { date: '2026-04-11', status: 'approved' });
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 800, tax_amount = 120, total_amount = 920, source_document_id = $3 WHERE id = $1', [bill, S2, doc]);
    const out = await asOwner(async () => {
      const p = await plan(S2, '2026-04-11');
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      expect(p.lines.map((l) => l.cc1Id ?? null)).toEqual([f.cc.FT]);
      await insertCaptureBillLines(bill, p.lines);
      return attachEvidenceAndSettleApproved({
        companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'approved',
        supplierId: S2, totalAmount: 920, invoiceDate: '2026-04-11', postUnattached: true,
      });
    });
    expect({ attached: out.attachedJeId !== null, refused: out.settlementRefused ?? null, status: (await billState(pool, bill)).status })
      .toEqual({ attached: true, refused: null, status: 'paid' });
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    expect(await postedOpexBySlice(pool, f, '2026-04')).toEqual({ [f.cc.FT]: 800 });
  });

  it('no unambiguous match (FT 400 + HT 400): the supplier default (HT)', async () => {
    await seedUnevidencedProvisional(pool, f, '2026-05-10', [{ amount: 400, cc1: f.cc.FT }, { amount: 400, cc1: f.cc.HT }], S2);
    const p = await asOwner(() => plan(S2, '2026-05-11'));
    expect('lines' in p && p.lines.map((l) => l.cc1Id ?? null)).toEqual([f.cc.HT]);
  });

  it('no provisional for the slip: the supplier default (HT)', async () => {
    const p = await asOwner(() => plan(S2, '2026-06-11'));
    expect('lines' in p && p.lines.map((l) => l.cc1Id ?? null)).toEqual([f.cc.HT]);
  });
});

describe('breaker 10b: a supplier default the dimension rules refuse is a capture plan refusal (as on REST)', () => {
  it('S3 defaults a project whose FNO is inactive: refused, nothing planned', async () => {
    const S3 = crypto.randomUUID();
    const fno = crypto.randomUUID();
    const proj = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S3', true)", [S3, f.co]);
    await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'FNO-X', 'Old FNO', 'cc1'),
                        ($2, $3, 'PRJ-X', 'Project X', 'cc2')`, [fno, proj, f.co]);
    await pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [proj, fno]);
    await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc2_id) VALUES ($1, $2, $3)', [f.co, S3, proj]);
    await pool.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [fno]);
    const p = await asOwner(() => plan(S3, '2026-07-11'));
    expect(p).toEqual({ refusal: expect.stringMatching(/CC1|cost centre/i) });
  });
});
