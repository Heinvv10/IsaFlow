/**
 * #678 review M1 / M3 / M6 / L2 / L3 against real Postgres: the carrier count
 * and the BU guard see a reference in each table they read; the alias DELETE
 * (ANY(::TEXT[])) removes exactly what the plan names; an unchanged inactive
 * parent is kept; defaults block a deactivation; a case-insensitive reference
 * that names two masters is refused; and two concurrent re-parents run one
 * after the other, so the second sees the first and refuses the loop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { countCc2Carriers } from '@/modules/accounting/services/core/costCentreUsageGuard';
import {
  applyUpdateDimensionCostCentre, planUpdateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import {
  applyUpdateBusinessUnit, deleteBusinessUnit, findBusinessUnit, planUpdateBusinessUnit,
} from '@/modules/accounting/services/core/businessUnitService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  bankLine, businessUnit, costCentre, dropBase, inRequest, journalLine, seedBase, tagHistory, type Base,
} from './dims-678.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
let b: Base;
const q = (text: string, values: unknown[]) => pool.query(text, values);

beforeAll(async () => { b = await seedBase(pool, company, user); }, 60000);
afterAll(async () => {
  try { await dropBase(pool, [company], [user]); } finally { await pool.end(); }
}, 60000);

const update = (ref: string, input: Parameters<typeof planUpdateDimensionCostCentre>[2]) => inRequest(pool, b, async () => {
  const plan = await planUpdateDimensionCostCentre(company, ref, input);
  await applyUpdateDimensionCostCentre(company, plan, user);
  return plan;
});

describe('countCc2Carriers reads each carrier table', () => {
  const CARRIERS: [string, (cc: string) => Promise<unknown>][] = [
    ['journal line', (cc) => journalLine(pool, b, 'cc2_id', cc)],
    ['bank line', (cc) => bankLine(pool, b, 'cc2_id', cc)],
    ['supplier invoice item', (cc) => q("INSERT INTO supplier_invoice_items(supplier_invoice_id, description, cc2_id) VALUES($1, 'x', $2)", [b.supplierInvoice, cc])],
    ['customer invoice item', (cc) => q("INSERT INTO customer_invoice_items(invoice_id, description, unit_price, amount, cc2_id) VALUES($1, 'x', 1, 1, $2)", [b.customerInvoice, cc])],
    ['credit note', (cc) => q("INSERT INTO credit_notes(company_id, type, credit_date, created_by, cc2_id) VALUES($1, 'customer', '2026-08-01', $2, $3)", [company, user, cc])],
    ['account default', (cc) => q('UPDATE gl_accounts SET default_cc2_id = $2 WHERE id = $1', [b.bank, cc])],
    ['tag history', (cc) => tagHistory(pool, b, 'old_cc2_id', cc)],
  ];
  it.each(CARRIERS)('%s', async (label, plant) => {
    const cc = await costCentre(pool, company, `CAR-${CARRIERS.findIndex((c) => c[0] === label)}`, 'cc2');
    const spare = await costCentre(pool, company, `CAR-S${CARRIERS.findIndex((c) => c[0] === label)}`, 'cc2');
    await plant(cc);
    expect(await inRequest(pool, b, () => countCc2Carriers(company, [cc, spare]))).toBe(1);
    expect(await inRequest(pool, b, () => countCc2Carriers(company, [spare]))).toBe(0);
    await q('UPDATE gl_accounts SET default_cc2_id = NULL WHERE company_id = $1', [company]);
  });
});

describe('the BU guard reads each table that carries a BU', () => {
  const PLANTS: [string, string, (bu: string) => Promise<unknown>][] = [
    ['journal line', 'journal line(s)', (bu) => journalLine(pool, b, 'bu_id', bu)],
    ['bank line', 'bank transaction(s)', (bu) => bankLine(pool, b, 'bu_id', bu)],
    ['supplier invoice item', 'document line(s)', (bu) => q("INSERT INTO supplier_invoice_items(supplier_invoice_id, description, bu_id) VALUES($1, 'x', $2)", [b.supplierInvoice, bu])],
    ['customer invoice item', 'document line(s)', (bu) => q("INSERT INTO customer_invoice_items(invoice_id, description, unit_price, amount, bu_id) VALUES($1, 'x', 1, 1, $2)", [b.customerInvoice, bu])],
    ['credit note', 'document line(s)', (bu) => q("INSERT INTO credit_notes(company_id, type, credit_date, created_by, bu_id) VALUES($1, 'customer', '2026-08-01', $2, $3)", [company, user, bu])],
    ['account default', 'account default(s)', (bu) => q('UPDATE gl_accounts SET default_bu_id = $2 WHERE id = $1', [b.bank, bu])],
    ['tag history', 'un-reversed tag batch line(s)', (bu) => tagHistory(pool, b, 'old_bu_id', bu)],
  ];
  it.each(PLANTS)('%s refuses the delete', async (label, expected, plant) => {
    const bu = await businessUnit(pool, company, `BU-${PLANTS.findIndex((p) => p[0] === label)}`);
    await plant(bu);
    const err = await inRequest(pool, b, () => deleteBusinessUnit(company, bu)).catch((e: Error) => e);
    expect((err as Error).message).toContain(`1 ${expected}`);
    expect((await q('SELECT 1 FROM business_units WHERE id = $1', [bu])).rowCount).toBe(1);
    await q('UPDATE gl_accounts SET default_bu_id = NULL WHERE company_id = $1', [company]);
  });

  it('a journal line in another tenant is held by the FK, and the transaction stays usable', async () => {
    const otherCo = crypto.randomUUID();
    const ob = await seedBase(pool, otherCo, user);
    try {
      const bu = await businessUnit(pool, company, 'BU-XT');
      await journalLine(pool, ob, 'bu_id', bu);
      const out = await inRequest(pool, b, async (c) => ({
        err: await deleteBusinessUnit(company, bu).catch((e: Error) => e),
        after: (await c.query('SELECT 1 AS ok')).rows[0].ok,
      }));
      expect((out.err as Error).message).toMatch(/Cannot delete business unit that is used by other records/);
      expect(out.after).toBe(1);
    } finally { await dropBase(pool, [otherCo], []); }
  });
});

describe('edits', () => {
  it('removes aliases by normalised key and adds the new ones (ANY(::TEXT[]))', async () => {
    const cc = await costCentre(pool, company, 'AL-1');
    await q("INSERT INTO cost_centre_aliases(company_id, cost_centre_id, alias, alias_normalized) VALUES($1,$2,'Ben Farms','ben farms'),($1,$2,'Keep','keep')", [company, cc]);
    await update('AL-1', { removeAliases: ['BEN  farms'], addAliases: ['Mohadin'] });
    const rows = await q('SELECT alias_normalized FROM cost_centre_aliases WHERE cost_centre_id = $1 ORDER BY 1', [cc]);
    expect(rows.rows.map((r) => r.alias_normalized)).toEqual(['keep', 'mohadin']);
  });

  it('keeps an unchanged inactive parent on edit (M3)', async () => {
    const fno = await costCentre(pool, company, 'M3-F', 'cc1', null, false);
    const proj = await costCentre(pool, company, 'M3-P', 'cc2', fno, false);
    await update('M3-P', { parent: fno, name: 'Renamed' });
    expect((await q('SELECT name, parent_id FROM cost_centres WHERE id = $1', [proj])).rows[0]).toEqual({ name: 'Renamed', parent_id: fno });
  });

  it('refuses deactivating a centre that is a customer or account default, naming the counts (L3)', async () => {
    const cc = await costCentre(pool, company, 'L3-D');
    await q('UPDATE customers SET default_cc1_id = $2 WHERE id = $1', [b.customer, cc]);
    await q('UPDATE gl_accounts SET default_cc1_id = $2 WHERE id = $1', [b.bank, cc]);
    await q('INSERT INTO supplier_coding_rules(company_id, supplier_id, default_cost_centre_id) VALUES($1, $2, $3)', [company, b.supplier, cc]);
    await expect(update('L3-D', { isActive: false })).rejects.toThrow(/default on 1 customer\(s\), 1 account\(s\), 1 supplier coding rule\(s\)/);
    await q('DELETE FROM supplier_coding_rules WHERE default_cost_centre_id = $1', [cc]);
    await q('UPDATE customers SET default_cc1_id = NULL WHERE id = $1', [b.customer]);
    await q('UPDATE gl_accounts SET default_cc1_id = NULL WHERE id = $1', [b.bank]);
    const bu = await businessUnit(pool, company, 'L3-BU');
    await q('UPDATE gl_accounts SET default_bu_id = $2 WHERE id = $1', [b.bank, bu]);
    await expect(inRequest(pool, b, async () => applyUpdateBusinessUnit(company, await planUpdateBusinessUnit(company, bu, { isActive: false }))))
      .rejects.toThrow(/default on 1 account\(s\)/);
    await q('UPDATE gl_accounts SET default_bu_id = NULL WHERE id = $1', [b.bank]);
  });

  it('refuses a code matching more than one master ignoring case, even an exact one; the id or cc_type picks (L2, round 2)', async () => {
    const lower = await businessUnit(pool, company, 'ops');
    await businessUnit(pool, company, 'OPS');
    await expect(inRequest(pool, b, () => findBusinessUnit(company, 'Ops'))).rejects.toThrow(/matches 2 business units/);
    await expect(inRequest(pool, b, () => findBusinessUnit(company, 'ops'))).rejects.toThrow(/send its id/);
    expect((await inRequest(pool, b, () => findBusinessUnit(company, lower))).id).toBe(lower);
    await costCentre(pool, company, 'dup-cc');
    const upper = await costCentre(pool, company, 'DUP-CC', 'cc2');
    await expect(update('dup-cc', { name: 'x' })).rejects.toThrow(/matches 2 cost centres .*send its id, or its cc_type/);
    const plan = await inRequest(pool, b, () => planUpdateDimensionCostCentre(company, 'dup-cc', { name: 'x' }, 'cc2'));
    expect(plan.before.id).toBe(upper);
  });

  it('refuses a case-only rename onto another code instead of a 23505 (L2)', async () => {
    await businessUnit(pool, company, 'fin');
    const fin2 = await businessUnit(pool, company, 'Fin');
    await expect(inRequest(pool, b, async () => applyUpdateBusinessUnit(company, await planUpdateBusinessUnit(company, fin2, { code: 'fin' }))))
      .rejects.toThrow(/code fin already exists/);
    await costCentre(pool, company, 'case-a');
    const caseB = await costCentre(pool, company, 'Case-A');
    await expect(update(caseB, { code: 'case-a' })).rejects.toThrow(/already the code or an alias of case-a/);
  });
});

describe('M1: concurrent re-parents run one after the other', () => {
  it('the second re-parent waits for the first and then sees the loop', async () => {
    const fno = await costCentre(pool, company, 'M1-F');
    await costCentre(pool, company, 'M1-X', 'cc2', fno);
    await costCentre(pool, company, 'M1-Y', 'cc2', fno);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = inRequest(pool, b, async () => {
      await applyUpdateDimensionCostCentre(company, await planUpdateDimensionCostCentre(company, 'M1-X', { parent: 'M1-Y' }), user);
      await gate; // hold the transaction open
    });
    await new Promise((r) => setTimeout(r, 300));
    const second = update('M1-Y', { parent: 'M1-X' }).then(() => 'committed', (e: Error) => e.message);
    let blocked = false;
    for (let i = 0; i < 30 && !blocked; i++) {
      blocked = Boolean((await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'")).rowCount);
      if (!blocked) await new Promise((r) => setTimeout(r, 100));
    }
    release();
    await first;
    expect(await second).toMatch(/would make a loop/);
    expect(blocked).toBe(true);
  });
});
