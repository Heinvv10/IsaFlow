/**
 * Budgets P5-2b, breaker round 1 (PR #1132): the unattended bill writers must keep the supplier's default
 * dimensions, or block mode turns their bills into off-slice refusals. REPRO 1: a recurring bill took no supplier
 * default CC1 (it wrote gl_account_id only); REPRO 2: a capture bill took none either. Both now resolve their lines
 * through `resolveBillLineDimensions`, as `createSupplierInvoice` does. Real PostgreSQL as app_user. Fixture: opex
 * BB-6100 at CC1 FT 1 000 / HT 0 a month (FY2027 = Mar 2026 - Feb 2027); the supplier's coding rule defaults CC1 to
 * FT. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import { ensureDocumentNumbers } from '@/modules/accounting/services/core/companySettingsService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { insertCaptureBillLines, planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-brk');
  await ensureDocumentNumbers(f.co);
  // The supplier's default CC1 is FT (migration 890): every bill a person or agent creates for it lands on FT.
  await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc1_id) VALUES ($1, $2, $3)',
    [f.co, f.supplier, f.cc.FT]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `supplier-invoice-action:${u}`)]);
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM supplier_coding_rules WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try { const out = await r.run(fn); await r.commit(); return out; } finally { await r.rollback(); }
}

/** An auto-post bill template: one opex line of 300 (plus `line`), for `supplier`. */
async function template(supplier: string, line: Record<string, unknown> = {}): Promise<string> {
  const tpl = crypto.randomUUID();
  await pool.query(
    `INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type, template_data, frequency, auto_post, created_by)
     VALUES ($1, $2, $3, 'supplier_invoice', $4, 'monthly', true, $5)`,
    [tpl, f.co, `BRK rec ${tpl.slice(0, 6)}`, JSON.stringify({
      supplierId: supplier,
      lines: [{ description: 'Rent', quantity: 1, unitPrice: 300, taxRate: 15, lineTotal: 300, accountId: f.acc.opex, ...line }],
    }), f.owner]);
  return tpl;
}
const itemDims = async (bill: string) => (await pool.query(
  'SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill])).rows.map((r) => r.cc1 as string | null);

describe('REPRO 1: recurring auto-post ignores the supplier default CC1, so block now leaves it a draft', () => {
  it('control: the same bill created through createSupplierInvoice lands on FT (the supplier default)', async () => {
    const inv = await asOwner(() => createSupplierInvoice(f.co, {
      supplierId: f.supplier, invoiceNumber: `BRK-${crypto.randomUUID().slice(0, 6)}`, invoiceDate: '2026-11-04',
      items: [{ description: 'Rent', quantity: 1, unitPrice: 300, glAccountId: f.acc.opex }],
    } as never, f.owner));
    const row = (await pool.query('SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [inv.id])).rows[0];
    expect(row.cc1).toBe(f.cc.FT);
  });

  it('block: a recurring bill for the same supplier and account posts (FT has 1 000 left)', async () => {
    await setPolicy(pool, f, 'block');
    const tpl = await template(f.supplier);
    const out = await asOwner(() => executeRecurring(f.co, tpl, f.owner));
    const items = (await pool.query('SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [out.entityId])).rows;
    expect({ posted: out.posted, warnings: out.warnings, cc1: items.map((i) => i.cc1) }).toEqual({ posted: true, warnings: undefined, cc1: [f.cc.FT] });
  });
});

describe('recurring template dimensions', () => {
  it('a CC1 the template line names wins over the supplier default and is written', async () => {
    await setPolicy(pool, f, 'off');
    const tpl = await template(f.supplier, { cc1Id: f.cc.HT });
    const out = await asOwner(() => executeRecurring(f.co, tpl, f.owner));
    expect(await itemDims(out.entityId)).toEqual([f.cc.HT]);
  });

  it('a CC1 that is not this company\'s, or not an id, is refused before any write', async () => {
    await setPolicy(pool, f, 'off');
    for (const cc1Id of [crypto.randomUUID(), 'FT']) {
      const tpl = await template(f.supplier, { cc1Id });
      await expect(asOwner(() => executeRecurring(f.co, tpl, f.owner))).rejects.toMatchObject({ code: 'RECURRING_TEMPLATE_LINE_ACCOUNT' });
    }
  });

  it('block, a supplier with no default and a line with no centre: left a draft, worded for the person who opens it', async () => {
    await setPolicy(pool, f, 'block');
    const bare = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'No default', true)", [bare, f.co]);
    const tpl = await template(bare);
    const out = await asOwner(() => executeRecurring(f.co, tpl, f.owner));
    expect(out.posted).toBe(false);
    expect((await billState(pool, out.entityId)).status).toBe('draft');
    const w = out.warnings?.join(' ') ?? '';
    expect(w).toContain('BB-6100 Opex · no cost centre 1');
    expect(w).toContain('The bill was left as a draft: an owner or admin can approve it with an override and a reason, or cancel it and enter it again with a budgeted cost centre 1 on its line.');
    expect(w).not.toMatch(/on its own in the app|assign|update_supplier_invoice/);
  });
});

describe('REPRO 2: a capture auto-approved bill ignores the supplier rule default CC1, so block withdraws it to draft', () => {
  it('block: the auto-approved capture bill (rule: opex, CC1 FT) posts', async () => {
    await setPolicy(pool, f, 'block');
    const doc = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'inv.pdf', 'application/pdf')`, [doc, f.co]);
    const bill = await makeBill(pool, f, [], { date: '2026-10-15', status: 'approved' });
    await pool.query('UPDATE supplier_invoices SET subtotal = 200, tax_amount = 30, total_amount = 230, source_document_id = $2 WHERE id = $1', [bill, doc]);
    const out = await asOwner(async () => {
      const plan = await planCaptureBillLines(f.co, {
        supplierId: f.supplier, invoiceNumber: 'X', invoiceDate: '2026-10-15', totalAmount: 230, taxAmount: 30, taxRate: 15, items: [],
      }, 0, null, { defaultGlAccountId: f.acc.opex, defaultCc1Id: f.cc.FT } as never);
      if (!('lines' in plan) || !plan.lines) throw new Error(JSON.stringify(plan));
      await insertCaptureBillLines(bill, plan.lines);
      return attachEvidenceAndSettleApproved({
        companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'approved',
        supplierId: f.supplier, totalAmount: 230, invoiceDate: '2026-10-15', postUnattached: true,
      });
    });
    const items = (await pool.query('SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill])).rows;
    expect({ refused: out.settlementRefused ?? null, status: (await billState(pool, bill)).status, cc1: items.map((i) => i.cc1) })
      .toEqual({ refused: null, status: 'approved', cc1: [f.cc.FT] });
  });
});
