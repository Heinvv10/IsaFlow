/**
 * ap_open_items / ar_open_items against a real database: Σ Outstanding equals
 * the aged_creditors / aged_debtors net total to the cent, the line-derived
 * dimensions read MIXED when the lines disagree, and Has_Document reads the
 * entity document store (direct or linked) for this company's documents only.
 *
 * Fixture: l2-credit-note-fifo.helpers (one disposable company, documents by
 * plain SQL). Figures worked by hand in each test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { setupFixture, makeBill, makeInvoice, makeApprovedNote, type Fixture } from './l2-credit-note-fifo.helpers';
import { buildOpenItems } from '@/modules/accounting/services/reports/openItemsExport';
import { agedCreditorsTool, agedDebtorsTool } from '@/lib/mcp/tools/reportsAging';
import type { McpToolContext } from '@/lib/mcp/types';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const payload = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
const cents = (n: unknown) => Math.round(Number(n) * 100);

let f: Fixture;
let ctx: McpToolContext;
const ids = { bill1: '', bill2: '', ccA: randomUUID(), ccB: randomUUID(), supplier2: randomUUID(), note: '' };

async function item(billId: string, total: number, cc1: string): Promise<void> {
  await f.pool.query(
    `INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,cc1_id)
     VALUES($1,'line',1,$2,$2,$3)`, [billId, total, cc1]);
}

describeIfDb('open-items export ties to the aged reports', () => {
  beforeAll(async () => {
    f = await setupFixture('OIX');
    ctx = { userId: f.user, companyId: f.company, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
    await f.pool.query(
      `INSERT INTO cost_centres(id,company_id,code,name,cc_type) VALUES($1,$3,'OIX-A','A','cc1'),($2,$3,'OIX-B','B','cc1')`,
      [ids.ccA, ids.ccB, f.company]);
    ids.bill1 = await makeBill(f, 'OIX-B1', 1000, '2026-03-01');
    await item(ids.bill1, 600, ids.ccA);
    await item(ids.bill1, 400, ids.ccB);
    ids.bill2 = await makeBill(f, 'OIX-B2', 2000, '2026-04-01');
    await item(ids.bill2, 2000, ids.ccA);
    await f.pool.query(
      `INSERT INTO procurement_documents(entity_type,entity_id,document_name,is_active)
       VALUES('supplier_invoice',$1,'bill1.pdf',true)`, [ids.bill1]);
    // 500 of supplier credit nobody applied, and 300 of cash.
    ids.note = await makeApprovedNote(f, { type: 'supplier', number: 'OIX-CN', total: 500, creditDate: '2026-05-01' });
    await f.pool.query('UPDATE credit_notes SET cc1_id = $2 WHERE id = $1', [ids.note, ids.ccA]);
    await f.pool.query(
      `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,$3,'2026-06-01',300,'eft','processed',$4)`, [randomUUID(), f.company, f.supplier, f.user]);
    // A supplier with cash on account and no open bill: a report row of its own.
    await f.pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [ids.supplier2, f.company, 'OIX supplier 2']);
    await f.pool.query(
      `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,$3,'2026-06-02',120.45,'eft','processed',$4)`, [randomUUID(), f.company, ids.supplier2, f.user]);
    await makeInvoice(f, 'OIX-I1', 800.1, '2026-02-01');
    await f.pool.query(
      `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,payment_method,status,created_by)
       VALUES($1,$2,$3,'2026-06-01',300,'eft','confirmed',$4)`, [randomUUID(), f.company, f.customer, f.user]);
  }, 60000);

  afterAll(async () => {
    await f.pool.query('DELETE FROM procurement_documents WHERE entity_id = ANY($1::UUID[])', [[ids.bill1, ids.bill2]]);
    await f.pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id = ANY($1::UUID[])', [[ids.bill1, ids.bill2]]);
    await f.pool.query('DELETE FROM cost_centres WHERE company_id = $1', [f.company]);
    await f.cleanup();
  }, 60000);

  it('AP: Σ Outstanding = aged_creditors total (3000 − 500 − 300 − 120.45 = 2079.55)', async () => {
    const out = await buildOpenItems(f.company, 'ap');
    const aged = payload(await agedCreditorsTool.handler({}, ctx));
    expect(out.rows.reduce((s, r) => s + cents(r.Outstanding), 0)).toBe(cents(aged.total));
    expect(cents(out.summary.controlTotal)).toBe(cents(aged.total));
    expect(cents(out.summary.grossTotal)).toBe(cents(aged.gross_total));
    expect(out.summary.difference).toBe(0);
    expect(out.summary.controlTotal).toBe(2079.55);
    expect(out.rows).toHaveLength(5);
  }, 60000);

  it('AP: dimensions from the lines (MIXED when they differ), header dimensions on a credit note, Has_Document', async () => {
    const out = await buildOpenItems(f.company, 'ap');
    const byId = new Map(out.rows.map((r) => [r.Doc_ID, r]));
    expect(byId.get(ids.bill1)).toMatchObject({ Doc_Type: 'invoice', CC1_Code: 'MIXED', Has_Document: true, Outstanding: 1000 });
    expect(byId.get(ids.bill2)).toMatchObject({ CC1_Code: 'OIX-A', Has_Document: false, Doc_No: 'OIX-B2' });
    expect(byId.get(ids.note)).toMatchObject({ Doc_Type: 'credit_note', CC1_Code: 'OIX-A', Outstanding: -500 });
    expect(out.rows.filter((r) => r.Doc_Type === 'unapplied_payment').map((r) => r.Outstanding).sort())
      .toEqual([-120.45, -300].sort());
  }, 60000);

  it('AR: Σ Outstanding = aged_debtors total (800.10 − 300 = 500.10)', async () => {
    const out = await buildOpenItems(f.company, 'ar');
    const aged = payload(await agedDebtorsTool.handler({}, ctx));
    expect(out.rows.reduce((s, r) => s + cents(r.Outstanding), 0)).toBe(cents(aged.total));
    expect(out.summary.controlTotal).toBe(500.1);
    expect(out.summary.difference).toBe(0);
  }, 60000);
});
