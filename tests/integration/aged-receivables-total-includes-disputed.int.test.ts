/**
 * Two screens disagreed about what customers owe. With an open R300 dispute the Aged Debtors screen's Total left the
 * disputed amount out (42 065.50) while Reports > Aged Receivables included it (42 365.50). Ruling: a disputed amount is
 * still owed, so every receivables Total includes it, and the disputed part is a breakdown column beside the buckets.
 *
 * Fixture (R42 365.50 owed, R300 of it in dispute): 20 000.00 not yet due, 21 765.50 15 days overdue, 600.00 45 days
 * overdue with R300 disputed. Every surface that states a receivables total is compared with the same figure: the screen's
 * route, its CSV, Reports > Aged Receivables, the aged_debtors tool, the AFS notes' totals, the subledger reconciliation's
 * aged total, the aging report and the open-items export. Aged Creditors has no disputes and must be unmoved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { fmtDate } from '@/lib/fmtDate';
import { setupFixture, type Fixture } from './l2-credit-note-fifo.helpers';
import { request, response, assertDisposable } from './mfa-impersonation-postgres.helpers';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getAgedReportTotal } from '@/modules/accounting/services/reconciliation/agedReportTotal';
import { getAgedBucketTotals } from '@/modules/accounting/services/reports/agedBucketTotals';
import { getAgingReport } from '@/modules/accounting/services/reports/agingReportService';
import { buildOpenItems } from '@/modules/accounting/services/reports/openItemsExport';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getSalesFigures } from '@/modules/accounting/services/workbench/monthEndSalesFigures';
import { agedCreditorsTool, agedDebtorsTool } from '@/lib/mcp/tools/reportsAging';
import type { McpToolContext } from '@/lib/mcp/types';
import arAgingRoute from '../../pages/api/accounting/ar-aging';
import arAgingExport from '../../pages/api/accounting/ar-aging-export';
import reportsArAging from '../../pages/api/accounting/reports-ar-aging';
import apAgingRoute from '../../pages/api/accounting/ap-aging';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TODAY = fmtDate(new Date());
const shift = (days: number): string => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const payload = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
const cents = (n: unknown) => Math.round(Number(n) * 100);

const OWED = 42365.5;
const DISPUTED = 300;

let f: Fixture;
let token = '';
let ctx: McpToolContext;

async function invoice(num: string, total: number, due: string): Promise<string> {
  const id = randomUUID();
  await f.pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date,due_date)
     VALUES($1,$2,$3,$4,$4,$5,$5,0,'approved',$6,$7,$8)`, [id, f.company, num, f.customer, total, f.user, shift(-90), due]);
  return id;
}

async function call(route: unknown, query: Record<string, string> = {}): Promise<{ status: number; body: unknown; text: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: f.company }, 'GET');
  (req as unknown as { query: unknown }).query = { as_at_date: TODAY, ...query };
  const out = response();
  await (route as (a: unknown, b: unknown) => Promise<void>)(req, out.res);
  return { status: out.state.statusCode, body: out.state.body, text: out.state.body };
}

describeIfDb('every receivables total includes the disputed amount', () => {
  beforeAll(async () => {
    assertDisposable();
    f = await setupFixture('AGD');
    ctx = { userId: f.user, companyId: f.company, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
    await invoice('AGD-1', 20000, shift(10));
    await invoice('AGD-2', 21765.5, shift(-15));
    const disputed = await invoice('AGD-3', 600, shift(-45));
    await f.pool.query(
      `INSERT INTO customer_invoice_disputes (company_id, customer_invoice_id, reason, raised_by, disputed_amount) VALUES ($1,$2,'fixture',$3,$4)`,
      [f.company, disputed, f.user, DISPUTED]);
    // A second tenant's debt must never reach any total.
    const other = await setupFixture('AGD2');
    await other.pool.query(
      `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,subtotal,total_amount,amount_paid,status,created_by,invoice_date,due_date)
       VALUES($1,$2,'AGD2-1',$3,$3,9999,9999,0,'approved',$4,$5,$6)`, [randomUUID(), other.company, other.customer, other.user, shift(-90), shift(-30)]);
    (globalThis as { __otherAgd?: Fixture }).__otherAgd = other;
    // Aged Creditors: a bill, no disputes (the control).
    await f.pool.query(
      `INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,total_amount,amount_paid,status,created_by)
       VALUES($1,$2,$3,'AGD-B1',$4,$5,1234.56,1234.56,0,'approved',$6)`, [randomUUID(), f.company, f.supplier, shift(-60), shift(-20), f.user]);
    token = await new SignJWT({ sub: f.user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await f.pool.query('DELETE FROM customer_invoice_disputes WHERE company_id = $1', [f.company]);
    await f.pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [f.company]);
    await f.cleanup();
    await (globalThis as { __otherAgd?: Fixture }).__otherAgd?.cleanup();
  }, 60000);

  it('the aging service: the row total is everything owed, the buckets are net of the dispute, the dispute is its own figure', async () => {
    const rows = await getARAging(f.company, TODAY);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(cents(r.total)).toBe(cents(OWED));
    expect(cents(r.disputed)).toBe(cents(DISPUTED));
    expect(cents(r.current + r.days30 + r.days60 + r.days90 + r.days120Plus + (r.disputed ?? 0))).toBe(cents(r.total)); // the row foots
    expect(cents(r.days60)).toBe(cents(300)); // the 45-day invoice's undisputed 300
  });

  it('Aged Debtors screen and its CSV: Total is 42 365.50 and the disputed 300 is a column', async () => {
    const screen = await call(arAgingRoute);
    expect(screen.status).toBe(200);
    const rows = (screen.body as { data: Array<{ total: number; disputed?: number }> }).data;
    expect(cents(rows.reduce((s, r) => s + r.total, 0))).toBe(cents(OWED));
    expect(cents(rows.reduce((s, r) => s + (r.disputed ?? 0), 0))).toBe(cents(DISPUTED));

    const exported = await call(arAgingExport);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const csv = String(exported.body).split('\n');
    expect(csv[0]).toBe('Customer,Current,30 Days,60 Days,90 Days,120+ Days,Disputed,Total');
    const totals = (csv.find((l) => l.includes('TOTALS')) ?? JSON.stringify(csv)).split(',');
    expect(cents(totals.at(-1))).toBe(cents(OWED));
    expect(cents(totals.at(-2))).toBe(cents(DISPUTED));
  });

  it('Reports > Aged Receivables: the same 42 365.50', async () => {
    const out = await call(reportsArAging);
    const summary = (out.body as { data: { summary: Array<{ total: number }> } }).data.summary;
    expect(cents(summary.reduce((s, b) => s + Number(b.total), 0))).toBe(cents(OWED));
  });

  it('aged_debtors (MCP): total, gross_total and the buckets-plus-disputed all say 42 365.50', async () => {
    const out = payload(await agedDebtorsTool.handler({}, ctx)) as { total: number; gross_total: number; buckets: Record<string, number> };
    expect(cents(out.total)).toBe(cents(OWED));
    expect(cents(out.gross_total)).toBe(cents(OWED));
    expect(cents(out.buckets.disputed)).toBe(cents(DISPUTED));
    const b = out.buckets;
    expect(cents(b.current + b.days30 + b.days60 + b.days90 + b.days120Plus + b.disputed)).toBe(cents(out.gross_total));
  });

  it('the notes\' bucket totals, the subledger reconciliation\'s aged total and the aging report agree', async () => {
    expect(cents((await getAgedBucketTotals(f.company, 'ar', TODAY)).gross)).toBe(cents(OWED));
    expect(cents(await getAgedReportTotal(f.company, 'ar', TODAY))).toBe(cents(OWED));
    expect(cents((await getAgingReport(f.company, 'ar', TODAY)).totals.total)).toBe(cents(OWED));
  });

  it('the open-items export: outstanding plus disputed is the aged total, and it still ties', async () => {
    const out = await buildOpenItems(f.company, 'ar', TODAY);
    expect(cents(out.summary.agedGrossTotal)).toBe(cents(OWED));
    expect(cents(out.summary.disputedTotal)).toBe(cents(DISPUTED));
    expect(cents(out.summary.grossTotal)).toBe(cents(OWED));
    expect(cents(out.summary.controlTotal)).toBe(cents(out.summary.agedTotal));
    expect(out.summary.difference).toBe(0);
  });

  it('a book with a dispute foots: the aged total plus the aged_to_subledger bridge is the subledger total, with no disputed_amount item', async () => {
    const rec = await reconcileSubledger(f.company, 'ar', TODAY);
    const aged = rec.reconcilingItems.filter((i) => i.bridge === 'aged_to_subledger');
    expect(aged.some((i) => i.type === 'disputed_amount')).toBe(false);
    expect(cents(rec.agedTotal)).toBe(cents(OWED));
    expect(cents(rec.subledgerTotal)).toBe(cents(OWED));
    expect(cents((rec.agedTotal ?? 0) + aged.reduce((x, i) => x + i.amount, 0))).toBe(cents(rec.subledgerTotal));
  });

  it('the month-end Sales card states the same total in a past period and in the current one, disputes included', async () => {
    const past = await getSalesFigures(f.company, shift(-1), TODAY);
    const current = await getSalesFigures(f.company, TODAY, TODAY);
    expect(past.past).toBe(true);
    expect(current.past).toBe(false);
    expect(cents(past.total)).toBe(cents(OWED));
    expect(cents(current.total)).toBe(cents(OWED));
    // The undisputed 300 of the 45-day invoice and the 15-day one are overdue; the dispute is not counted as overdue on either path.
    expect(cents(past.overdue)).toBe(cents(current.overdue));
  });

  it("another tenant's debt reaches none of them", async () => {
    expect(cents(await getAgedReportTotal(f.company, 'ar', TODAY))).toBe(cents(OWED));
  });

  it('Aged Creditors (no disputes) is unmoved: the screen, the aging service and the tool agree on 1 234.56', async () => {
    const rows = await getAPAging(f.company, TODAY);
    expect(cents(rows.reduce((s, r) => s + r.total, 0))).toBe(cents(1234.56));
    expect(rows.every((r) => (r.disputed ?? 0) === 0)).toBe(true);
    const screen = (await call(apAgingRoute)).body as { data: Array<{ total: number }> };
    expect(cents(screen.data.reduce((s, r) => s + r.total, 0))).toBe(cents(1234.56));
    const tool = payload(await agedCreditorsTool.handler({}, ctx)) as { total: number; gross_total: number };
    expect(cents(tool.total)).toBe(cents(1234.56));
    expect(cents(tool.gross_total)).toBe(cents(1234.56));
  });
});
