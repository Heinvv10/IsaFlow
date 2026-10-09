/**
 * #683 round 3 item 5: the phase-5 seed's cost-centre wipe, run alone against
 * the fixture. With a centre named from every RESTRICT column (journal and bank
 * lines, document lines, a credit note, customer / account defaults, a coding
 * rule, an asset, a child centre), the wipe deletes the company's centres
 * without a 23503, keeps every line it untagged, and touches no other company.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createSql, closeSql } from '../../scripts/_pg';
import { wipePhase5CostCentres } from '../../scripts/seed-phase5-wipe';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { bankLine, costCentre, dropBase, journalLine, seedBase, type Base } from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
let b: Base;
let ob: Base;
const q = (text: string, values: unknown[]) => pool.query(text, values);
const ids: Record<string, string> = {};

beforeAll(async () => {
  b = await seedBase(pool, company, user);
  ob = await seedBase(pool, other, user);
  ids.fno = await costCentre(pool, company, 'W-F1');
  ids.proj = await costCentre(pool, company, 'W-P1', 'cc2', ids.fno);
  ids.line = await journalLine(pool, b, 'cc2_id', ids.proj);
  await q('UPDATE gl_journal_lines SET cc1_id = $2 WHERE id = $1', [ids.line, ids.fno]);
  ids.bank = await bankLine(pool, b, 'cc1_id', ids.fno);
  ids.sii = String((await q("INSERT INTO supplier_invoice_items(supplier_invoice_id, description, cc1_id, cc2_id) VALUES($1, 'x', $2, $3) RETURNING id",
    [b.supplierInvoice, ids.fno, ids.proj])).rows[0].id);
  ids.cii = String((await q("INSERT INTO customer_invoice_items(invoice_id, description, unit_price, amount, cc1_id, cc2_id) VALUES($1, 'x', 1, 1, $2, $3) RETURNING id",
    [b.customerInvoice, ids.fno, ids.proj])).rows[0].id);
  ids.cn = String((await q("INSERT INTO credit_notes(company_id, type, credit_date, created_by, cc1_id, cc2_id) VALUES($1, 'customer', '2026-08-01', $2, $3, $4) RETURNING id",
    [company, user, ids.fno, ids.proj])).rows[0].id);
  await q('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [b.customer, ids.fno]);
  await q('UPDATE gl_accounts SET default_cc1_id = $2, default_cc2_id = $3 WHERE id = $1', [b.bank, ids.fno, ids.proj]);
  await q('INSERT INTO supplier_coding_rules(company_id, supplier_id, default_cost_centre_id) VALUES($1, $2, $3)', [company, b.supplier, ids.proj]);
  await q(`INSERT INTO assets(company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, cost_centre_id)
           VALUES($1, 'W-A1', 'Van', '2026-01-01', 1000, 5, $2)`, [company, ids.fno]);
  await q('UPDATE payroll_employees SET cost_centre_id = $2 WHERE id = $1', [b.employee, ids.proj]);
  // The other company: its own centre on its own line — the wipe must not see it.
  ids.otherCc = await costCentre(pool, other, 'W-F1');
  ids.otherLine = await journalLine(pool, ob, 'cc1_id', ids.otherCc);
}, 60000);
afterAll(async () => {
  try {
    await q('DELETE FROM supplier_coding_rules WHERE company_id = ANY($1)', [[company, other]]);
    await dropBase(pool, [company, other], [user]);
  } finally { await pool.end(); await closeSql(); }
}, 60000);

it('deletes the company\'s centres with no 23503, untags what named them, and leaves another company alone', async () => {
  // The localhost fixture speaks no SSL; scripts/_pg turns it off only on sslmode=disable.
  const url = process.env.DATABASE_URL!;
  const sql = createSql(url.includes('sslmode=') ? url : `${url}${url.includes('?') ? '&' : '?'}sslmode=disable`);
  await wipePhase5CostCentres(sql as never, company);
  expect((await q('SELECT count(*)::int AS n FROM cost_centres WHERE company_id = $1', [company])).rows[0].n).toBe(0);
  // The lines survive, untagged — nothing was deleted but the centres.
  expect((await q('SELECT cc1_id, cc2_id FROM gl_journal_lines WHERE id = $1', [ids.line])).rows).toEqual([{ cc1_id: null, cc2_id: null }]);
  expect((await q('SELECT cc1_id FROM bank_transactions WHERE id = $1', [ids.bank])).rows).toEqual([{ cc1_id: null }]);
  for (const [table, id] of [['supplier_invoice_items', ids.sii], ['customer_invoice_items', ids.cii], ['credit_notes', ids.cn]] as const) {
    expect((await q(`SELECT cc1_id, cc2_id FROM ${table} WHERE id = $1`, [id])).rows).toEqual([{ cc1_id: null, cc2_id: null }]);
  }
  // The other company's centre and its tag are untouched.
  expect((await q('SELECT count(*)::int AS n FROM cost_centres WHERE id = $1', [ids.otherCc])).rows[0].n).toBe(1);
  expect((await q('SELECT cc1_id FROM gl_journal_lines WHERE id = $1', [ids.otherLine])).rows[0].cc1_id).toBe(ids.otherCc);
});
