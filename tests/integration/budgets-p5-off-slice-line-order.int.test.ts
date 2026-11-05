/**
 * Budgets P5-2b round 7 (breaker R6-1, reviewer LOW 2): the slip matcher must compute each line's posted net in the
 * order the STORED lines are read back for posting (`SUPPLIER_INVOICE_LINE_ORDER_BY`: lines written together tie on
 * created_at, so description order), not in extraction order: the last-line residual (an unread R0 price, gross
 * rounding) lands on whichever line posts last. Provisional FT 500 + HT 300; slip lines "Zebra hire" 500 and "Apple
 * sundries" 0 (the R0 line posts FIRST, Zebra takes the residual 800 - 0): extraction-order matching put FT on Zebra
 * and HT on Apple, so FT posted 800 and HT 0, a centre split the provisional never had.
 * Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0 (FY2027). Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { insertCaptureBillLines, planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { storedLineOrder } from '@/modules/accounting/services/ap/supplierInvoiceLineOrder';
import { netsInPostingOrder } from '@/modules/accounting/services/ap/supplierInvoiceProvisionalDims';
import { buildExpenseLines } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import { defaultVatClassification } from '@/modules/accounting/services/ap/supplierInvoiceTotals';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { applySupplierInvoiceDraftUpdate, lockAndPlanSupplierInvoiceDraftUpdate } from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import type { SupplierInvoiceItemInput } from '@/modules/accounting/types/ap.types';
import { callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';
import { seedUnevidencedProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
const S0 = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-line-order');
  await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S0', true)", [S0, f.co]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `supplier-invoice-action:${u}`)]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try { const out = await r.run(fn); await r.commit(); return out; } finally { await r.rollback(); }
}
/** The bill's posted opex debits per CC1 ('' none), from its own journal. */
async function postedByCc1(bill: string): Promise<Record<string, number>> {
  const rows = (await pool.query(`SELECT COALESCE(jl.cc1_id::TEXT, '') AS cc1, SUM(jl.debit - jl.credit)::FLOAT8 AS net
      FROM supplier_invoices si JOIN gl_journal_lines jl ON jl.journal_entry_id = si.gl_journal_entry_id
     WHERE si.id = $1 AND jl.gl_account_id = $2 GROUP BY 1`, [bill, f.acc.opex])).rows as Array<{ cc1: string; net: number }>;
  return Object.fromEntries(rows.map((r) => [r.cc1, r.net]));
}
/** A capture of S0 on `date` with these extracted lines (net 800, VAT 120), planned, written and attached. */
async function capture(date: string, items: Array<{ description: string; unitPrice: number }>): Promise<string> {
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const bill = await makeBill(pool, f, [], { date });
  await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 800, tax_amount = 120, total_amount = 920, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
  await asOwner(async () => {
    const p = await planCaptureBillLines(f.co, {
      supplierId: S0, invoiceNumber: 'X', invoiceDate: date, totalAmount: 920, taxAmount: 120, taxRate: 15,
      items: items.map((i) => ({ ...i, quantity: 1, taxRate: 15 })),
    } as never, items.length, f.acc.opex, null);
    if (!('lines' in p)) throw new Error(JSON.stringify(p));
    const slip = await insertCaptureBillLines(bill, p.lines);
    await attachEvidenceAndSettleApproved({ companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'draft',
      supplierId: S0, totalAmount: 920, invoiceDate: date, postUnattached: true, slip });
  });
  return bill;
}

describe('R6-1: nets in the stored (posting) order', () => {
  it('an R0 line that posts first: Zebra posts the whole 800, which matches no provisional line, so nothing is inherited (never FT 800)', async () => {
    await setPolicy(pool, f, 'off');
    await seedUnevidencedProvisional(pool, f, '2026-04-10', [{ amount: 500, cc1: f.cc.FT }, { amount: 300, cc1: f.cc.HT }], S0);
    const bill = await capture('2026-04-11', [{ description: 'Zebra hire', unitPrice: 500 }, { description: 'Apple sundries', unitPrice: 0 }]);
    const r = await callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: bill });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    // Apple (R0, posts first) carries 0; Zebra posts the residual 800, which neither provisional line matches alone:
    // nothing is inherited on a guess, rather than FT on the wrong amount.
    expect(await postedByCc1(bill)).toEqual({ '': 800 });
  });
});

describe('the matcher\'s nets = what buildExpenseLines posts from the STORED lines (round 7)', () => {
  /** Plans these extracted lines, takes the matcher's nets (posting order), writes them, posts-builds from the stored bill. */
  async function compare(date: string, items: Array<{ description: string; unitPrice: number }>, header: { subtotal: number; tax: number }) {
    const bill = await makeBill(pool, f, [], { date });
    const total = Math.round((header.subtotal + header.tax) * 100) / 100;
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = $3, tax_amount = $4, total_amount = $5 WHERE id = $1',
      [bill, S0, header.subtotal, header.tax, total]);
    return asOwner(async () => {
      const p = await planCaptureBillLines(f.co, {
        supplierId: S0, invoiceNumber: 'X', invoiceDate: date, totalAmount: total, taxAmount: header.tax, taxRate: 15,
        items: items.map((i) => ({ ...i, quantity: 1, taxRate: 15 })),
      } as never, items.length, f.acc.opex, null);
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      const order = await storedLineOrder(p.lines.map((l) => ({ ...l, vatClassification: defaultVatClassification(l.taxRate) })));
      const nets = netsInPostingOrder(p.lines, { subtotal: header.subtotal, totalAmount: total, taxRate: 15 }, order);
      const matcher = Object.fromEntries(p.lines.map((l, i) => [l.description, nets[i]!]));
      await insertCaptureBillLines(bill, p.lines);
      const stored = (await getSupplierInvoiceById(f.co, bill))!; // read back in posting order (SUPPLIER_INVOICE_LINE_ORDER_BY)
      // What posting debits per line (descriptions are unique here); a line posting R0.00 is dropped, so it reads 0.
      const posted = Object.fromEntries(p.lines.map((l) => [l.description, 0]));
      for (const d of buildExpenseLines(stored, 'unused')) posted[d.description!] = d.debit;
      return { matcher, posted, extraction: p.lines.map((l) => l.description), stored: (stored.items ?? []).map((i) => i.description) };
    });
  }

  it('non-alphabetical extraction with an R0 line: the residual is on the line that POSTS last', async () => {
    const r = await compare('2026-05-11', [{ description: 'Zebra hire', unitPrice: 500 }, { description: 'Mango', unitPrice: 0 }, { description: 'Apple', unitPrice: 0 }],
      { subtotal: 800, tax: 120 });
    expect(r.stored).toEqual(['Apple', 'Mango', 'Zebra hire']); // posting order differs from extraction order
    expect(r.matcher).toEqual(r.posted);
  });

  it('gross storage whose rounding residual moves with the order', async () => {
    const r = await compare('2026-05-12', [{ description: 'zz', unitPrice: 33.33 }, { description: 'Ab', unitPrice: 33.33 }, { description: 'mm', unitPrice: 33.34 }],
      { subtotal: 86.96, tax: 13.04 });
    expect(r.matcher).toEqual(r.posted);
  });
});

describe('round 8: the planned order IS the stored order (ids written), through capture and the MCP plan', () => {
  /** Posting debits per stored line, by id, in posting order (R0.00 lines read 0): expenseLineNets over the stored bill. */
  const postedById = (stored: { items?: Array<{ id: string; lineTotal: number }>; subtotal: number; totalAmount: number; taxRate: number }) => {
    const items = stored.items ?? [];
    const nets = netsInPostingOrder(items, stored);
    return Object.fromEntries(items.map((it, i) => [it.id, nets[i]!]));
  };

  it('a NULL-account line among account lines (capture; NULLS LAST on gl_account_id under one description)', async () => {
    const bill = await makeBill(pool, f, [], { date: '2026-06-11' });
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 600, tax_amount = 90, total_amount = 690 WHERE id = $1', [bill, S0]);
    const r = await asOwner(async () => {
      const p = await planCaptureBillLines(f.co, {
        supplierId: S0, invoiceNumber: 'X', invoiceDate: '2026-06-11', totalAmount: 690, taxAmount: 90, taxRate: 15,
        items: [{ description: 'Item', quantity: 1, unitPrice: 100, taxRate: 15 },
          { description: 'Item', quantity: 1, unitPrice: 200, taxRate: 15, glAccountId: f.acc.travel },
          { description: 'Item', quantity: 1, unitPrice: 300, taxRate: 15, glAccountId: f.acc.opex }],
      } as never, 3, null, null);
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      expect(p.lines.map((l) => l.glAccountId ?? null)).toEqual([null, f.acc.travel, f.acc.opex]);
      const order = await storedLineOrder(p.lines.map((l) => ({ ...l, vatClassification: defaultVatClassification(l.taxRate) })));
      const planned = order.map((i) => p.lines[i]!.id);
      const nets = netsInPostingOrder(p.lines, { subtotal: 600, totalAmount: 690, taxRate: 15 }, order);
      await insertCaptureBillLines(bill, p.lines);
      const stored = (await getSupplierInvoiceById(f.co, bill))!;
      return { planned, stored: (stored.items ?? []).map((i) => i.id), lastAccount: stored.items?.at(-1)?.glAccountId ?? null,
        matcher: Object.fromEntries(p.lines.map((l, i) => [l.id!, nets[i]!])), posted: postedById(stored) };
    });
    expect(r.planned).toEqual(r.stored);
    expect(r.lastAccount).toBeNull(); // the NULL-account line sorts last (NULLS LAST) and carries the residual
    expect(r.matcher).toEqual(r.posted);
  });

  /** A draft whose lines the MCP plan replaces with `items`: the planned order and nets against the stored bill. */
  async function mcpReplace(date: string, items: SupplierInvoiceItemInput[]) {
    const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 1 }], { date });
    return asOwner(async () => {
      const plan = await lockAndPlanSupplierInvoiceDraftUpdate(f.co, bill, { items });
      const lines = plan.lines!;
      const order = await storedLineOrder(lines.items.map((i) => ({
        id: i.id ?? null, description: i.description, glAccountId: i.glAccountId ?? null, quantity: i.quantity, unitPrice: i.unitPrice,
        taxRate: i.taxRate, taxAmount: i.taxAmount, lineTotal: i.lineTotal, vatClassification: defaultVatClassification(i.taxRate),
      })));
      const nets = netsInPostingOrder(lines.items, { subtotal: lines.subtotal, totalAmount: lines.totalAmount, taxRate: lines.taxRate }, order);
      await applySupplierInvoiceDraftUpdate(f.co, plan, f.owner);
      const stored = (await getSupplierInvoiceById(f.co, bill))!;
      return {
        planned: order.map((i) => lines.items[i]!.id), stored: (stored.items ?? []).map((i) => i.id),
        matcher: Object.fromEntries(lines.items.map((l, i) => [l.id!, nets[i]!])), posted: postedById(stored),
        cc1: (stored.items ?? []).map((i) => i.cc1Id ?? null),
      };
    });
  }

  it('matcher == posted through the MCP plan (non-alphabetical lines)', async () => {
    const r = await mcpReplace('2026-07-11', [
      { description: 'Zebra hire', quantity: 1, unitPrice: 333.33, glAccountId: f.acc.opex },
      { description: 'Apple', quantity: 3, unitPrice: 0.33, glAccountId: f.acc.opex },
      { description: 'Mango', quantity: 1, unitPrice: 0, glAccountId: f.acc.opex },
    ]);
    expect(r.planned).toEqual(r.stored);
    expect(r.matcher).toEqual(r.posted);
  });

  it('two lines identical on every sort column, one carrying a dimension: the planned ids fix their order', async () => {
    const r = await mcpReplace('2026-07-12', [
      { description: 'Same', quantity: 1, unitPrice: 100, glAccountId: f.acc.opex, cc1Id: f.cc.FT },
      { description: 'Same', quantity: 1, unitPrice: 100, glAccountId: f.acc.opex },
    ]);
    expect(r.planned).toEqual(r.stored);
    expect(r.matcher).toEqual(r.posted);
    expect([...r.cc1].sort()).toEqual([f.cc.FT, null].sort());
  });
});
