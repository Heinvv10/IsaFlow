// R-131 — capture/[id]/post wrote a supplier invoice with NO supplier_invoice_items.
//
// Every posting path builds the journal's expense side from the items
// (buildExpenseLines), so a bill with none books only DR VAT / CR AP — an
// unbalanced entry the validator refuses. An auto-approved capture therefore sat
// 'approved' with no journal: owing in the AP subledger, absent from the GL.
// Real PG, through the real withAuth route (app_user, GUCs, COMMIT on 4xx).
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import capturePostRoute from '../../pages/api/accounting/capture/[id]/post';
import { request, response } from './mfa-impersonation-postgres.helpers';
import {
  company, expenseGl, invoiceState, otherCompany, payableGl, pool, supplier, today, useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

let token = '';
/** A second expense account, the supplier's coding-rule default. */
const ruleGl = crypto.randomUUID();
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,'R131RULE','R131 Rule expense','expense','debit',true)`, [ruleGl, company]);
});

interface LineItem { description: string; quantity: number; unitPrice: number; total: number }

/** An extracted, unclaimed slip and its capture event, as the inbox shows it. */
async function seedCapture(opts: {
  total: number | null; vat?: number | null; lineItems?: LineItem[]; companyId?: string;
}): Promise<{ eventId: string; documentId: string }> {
  const c = opts.companyId ?? company;
  const documentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const total = opts.total;
  const vat = opts.vat !== undefined ? opts.vat
    : total === null ? null : Math.round((total - total / 1.15) * 100) / 100;
  const net = total === null ? null : Math.round((total - (vat ?? 0)) * 100) / 100;
  const extracted = {
    documentType: 'invoice', vendorName: 'R127 Supplies CC', date: today,
    referenceNumber: `R131-${documentId.slice(0, 8)}`, currency: 'ZAR', subtotal: net, vatAmount: vat, vatRate: 15,
    totalAmount: total, lineItems: opts.lineItems ?? [],
    rawText: `TAX INVOICE\nSub Total ${net}\nVAT ${vat}\nTotal ${total}`,
    confidence: 0.9, warnings: [], extractionMethod: 'vlm',
  };
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`,
    [documentId, c, `r131-${documentId}.pdf`, JSON.stringify(extracted)],
  );
  await pool.query(
    "INSERT INTO capture_events(id,company_id,channel,status,captured_document_id) VALUES($1,$2,'api','extracted',$3)",
    [eventId, c, documentId]);
  return { eventId, documentId };
}

async function postCapture(eventId: string): Promise<{ statusCode: number; body: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  req.url = `/api/accounting/capture/${eventId}/post`;
  (req as unknown as { query: Record<string, string> }).query = { id: eventId };
  req.body = {};
  const out = response();
  await capturePostRoute(req as never, out.res as never);
  return out.state;
}

async function billFor(documentId: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM supplier_invoices WHERE source_document_id=$1', [documentId]);
  expect(rows).toHaveLength(1);
  return String(rows[0].id);
}

async function itemsOf(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT description, quantity::float AS quantity, unit_price::float AS unit_price, line_total::float AS line_total,
            tax_amount::float AS tax_amount, gl_account_id
     FROM supplier_invoice_items WHERE supplier_invoice_id=$1 ORDER BY description`, [invoiceId]);
  return rows as Array<{ description: string; quantity: number; unit_price: number; line_total: number;
    tax_amount: number; gl_account_id: string | null }>;
}

/** The bill's journal, per account (debit − credit), plus whether it balances. */
async function journalOf(invoiceId: string) {
  const inv = await invoiceState(invoiceId);
  expect(inv.gl_journal_entry_id, 'the approved bill carries a journal').not.toBeNull();
  const { rows } = await pool.query(
    `SELECT l.gl_account_id, SUM(l.debit)::float AS dr, SUM(l.credit)::float AS cr
     FROM gl_journal_lines l JOIN gl_journal_entries je ON je.id = l.journal_entry_id
     WHERE je.id = $1 AND je.status = 'posted' GROUP BY l.gl_account_id`, [inv.gl_journal_entry_id]);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const net = (a: string) => r2(rows.filter((x) => x.gl_account_id === a).reduce((s, x) => s + x.dr - x.cr, 0));
  const dr = r2(rows.reduce((s, x) => s + x.dr, 0));
  const cr = r2(rows.reduce((s, x) => s + x.cr, 0));
  return { dr, cr, net };
}

async function untouched(eventId: string, documentId: string) {
  expect((await pool.query('SELECT id FROM supplier_invoices WHERE source_document_id=$1', [documentId])).rows)
    .toHaveLength(0);
  const doc = (await pool.query('SELECT status, posted_at FROM captured_documents WHERE id=$1', [documentId])).rows[0];
  expect(doc).toEqual({ status: 'pending', posted_at: null });
  const ev = (await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId])).rows[0];
  expect(ev.status).toBe('extracted');
}

describe('R-131: capture/[id]/post writes the bill\'s lines, and an auto-approved bill posts a balanced journal', () => {
  it('extracted line items become the bill\'s items, and the auto-approved bill posts balanced', async () => {
    // 200 + 3 × 50 = 350 net, 52.50 VAT, 402.50 total.
    const { eventId, documentId } = await seedCapture({
      total: 402.50, vat: 52.50,
      lineItems: [
        { description: 'A4 paper', quantity: 1, unitPrice: 200, total: 200 },
        { description: 'Toner', quantity: 3, unitPrice: 50, total: 150 },
      ],
    });
    const res = await postCapture(eventId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const invoiceId = await billFor(documentId);

    expect(await itemsOf(invoiceId)).toEqual([
      { description: 'A4 paper', quantity: 1, unit_price: 200, line_total: 200, tax_amount: 30, gl_account_id: null },
      { description: 'Toner', quantity: 3, unit_price: 50, line_total: 150, tax_amount: 22.5, gl_account_id: null },
    ]);
    expect((await invoiceState(invoiceId)).status).toBe('approved');
    const je = await journalOf(invoiceId);
    expect(je.dr).toBe(je.cr);
    expect(je.net(expenseGl)).toBe(350);
    expect(je.net(vatGl)).toBe(52.5);
    expect(je.net(payableGl)).toBe(-402.5);
  });

  it('no extracted lines: ONE line from the totals on the supplier\'s default account, journal balanced', async () => {
    await pool.query(
      'INSERT INTO supplier_coding_rules(company_id,supplier_id,default_gl_account_id) VALUES($1,$2,$3)',
      [company, supplier, ruleGl]);
    try {
      const { eventId, documentId } = await seedCapture({ total: 575, vat: 75 });
      const res = await postCapture(eventId);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const invoiceId = await billFor(documentId);

      const items = await itemsOf(invoiceId);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ quantity: 1, unit_price: 500, line_total: 500, tax_amount: 75, gl_account_id: ruleGl });
      expect((await invoiceState(invoiceId)).status).toBe('approved');
      const je = await journalOf(invoiceId);
      expect(je.dr).toBe(je.cr);
      expect(je.net(ruleGl)).toBe(500);
      expect(je.net(vatGl)).toBe(75);
      expect(je.net(payableGl)).toBe(-575);
    } finally {
      await pool.query('DELETE FROM supplier_coding_history WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM supplier_coding_rules WHERE company_id=$1', [company]);
    }
  });

  it('an auto-approved bill whose journal cannot post goes back to draft, off AP, and says so', async () => {
    const monthStart = `${today.slice(0, 8)}01`;
    const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    // The bill's date sits in a filed VAT period: posting its input VAT there is refused.
    const lock = (await pool.query(
      `INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
       VALUES($1,$2,$3,0,0,0,NOW(),$4,'human') RETURNING id`, [company, monthStart, monthEnd, user])).rows[0].id as string;
    try {
      const { eventId, documentId } = await seedCapture({
        total: 230, vat: 30, lineItems: [{ description: 'Cables', quantity: 2, unitPrice: 100, total: 200 }],
      });
      const res = await postCapture(eventId);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const invoiceId = await billFor(documentId);
      expect(await itemsOf(invoiceId)).toHaveLength(1);
      const inv = await invoiceState(invoiceId);
      expect(inv).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
      const notes = String((await pool.query('SELECT notes FROM supplier_invoices WHERE id=$1', [invoiceId])).rows[0].notes);
      expect(notes).toMatch(/Auto-approval withdrawn: its journal could not be posted/);
      expect((res.body as { data: { invoice: { status: string } } }).data.invoice.status).toBe('draft');
    } finally {
      await pool.query('UPDATE vat_period_locks SET unlocked_at=NOW(), unlocked_by=$2, unlock_reason=$3 WHERE id=$1',
        [lock, user, 'R131 test cleanup']);
    }
  });

  it('no total: 4xx, and nothing is inserted or claimed', async () => {
    // A line is extracted, so no account is needed: the total alone refuses it.
    const { eventId, documentId } = await seedCapture({
      total: 0, vat: null, lineItems: [{ description: 'Unpriced', quantity: 1, unitPrice: 0, total: 0 }],
    });
    const res = await postCapture(eventId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/total/i);
    await untouched(eventId, documentId);
  });

  it('another company\'s capture is refused, and nothing is inserted', async () => {
    const { eventId, documentId } = await seedCapture({ total: 402.50, vat: 52.50, companyId: otherCompany });
    const res = await postCapture(eventId);
    expect(res.statusCode).toBe(404);
    await untouched(eventId, documentId);
  });
});
