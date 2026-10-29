/**
 * Recurring-invoice PUT, against real Postgres.
 *
 *  1. End Date was never read by the PUT handler, so it could not be saved when
 *     editing. A body with the `endDate` key sets it (null / '' clears it); a
 *     body without the key keeps the stored value; garbage is refused.
 *  2. The handler used `req.body.taxRate ?? 15`. The edit page never sends
 *     taxRate, so editing the lines of a 0% / non-VAT template wrote 15% tax
 *     into tax_amount/total_amount while tax_rate stayed 0 — and the run then
 *     refused the template ("totals disagree with its lines"). An edit without
 *     taxRate now keeps the stored rate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringInvoices from '../../pages/api/accounting/recurring-invoices';
import recurringRun from '../../pages/api/accounting/recurring-invoices-run';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, newCompany } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupPr4(pool, companies, [user]));

interface Opts { taxRate: number; endDate?: string | null; due?: boolean; status?: string }

async function fixture(withGl = false): Promise<{ c: string; customer: string }> {
  const c = withGl ? await invoiceCompany(pool, [[user, 'admin']], companies) : await newCompany(pool, [[user, 'admin']], companies);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'PUT fixture')", [customer, c]);
  return { c, customer };
}

/** A R1 000 net monthly template whose stored header agrees with `taxRate`. */
async function template(c: string, customer: string, o: Opts): Promise<string> {
  const id = crypto.randomUUID();
  const tax = Math.round(1000 * o.taxRate) / 100;
  await pool.query(
    `INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,end_date,description,
       line_items,subtotal,tax_rate,tax_amount,total_amount,created_by,status)
     VALUES($1,$2,$3,$4,'monthly',CASE WHEN $5::BOOLEAN THEN CURRENT_DATE - 3 ELSE CURRENT_DATE + 30 END,$6::DATE,'PUT retainer',
       $7::jsonb,1000,$8,$9,$10,$11,$12)`,
    [id, c, `PUT ${id.slice(0, 6)}`, customer, o.due ?? false, o.endDate ?? null,
      JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 1000 }]), o.taxRate, tax, 1000 + tax, user,
      o.status ?? 'active']);
  return id;
}

const put = (c: string, body: Record<string, unknown>) =>
  callRoute(recurringInvoices, tokens[user]!, c, 'PUT', body, '/api/accounting/recurring-invoices');
const row = async (id: string) => (await pool.query(
  `SELECT end_date::text AS end_date, next_run_date::text AS next_run_date, status, tax_rate::float AS tax_rate, tax_amount::float AS tax_amount,
          total_amount::float AS total_amount, subtotal::float AS subtotal, template_name
     FROM recurring_invoices WHERE id = $1`, [id])).rows[0] as {
  end_date: string | null; next_run_date: string; status: string; tax_rate: number; tax_amount: number; total_amount: number; subtotal: number; template_name: string };
const lines = (unitPrice: number) => [{ description: 'Retainer', quantity: 2, unitPrice }];

describe('PUT recurring-invoices: End Date', () => {
  it('saves an End Date sent with the edit', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const res = await put(c, { id, endDate: '2027-03-31' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await row(id)).end_date).toBe('2027-03-31');
  });

  it('keeps the stored End Date when the body has no endDate key', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2027-06-30' });
    const res = await put(c, { id, templateName: 'renamed' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ end_date: '2027-06-30', template_name: 'renamed' });
  });

  it.each([null, ''])('clears the End Date for endDate = %j', async (value) => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2027-06-30' });
    const res = await put(c, { id, endDate: value });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await row(id)).end_date).toBeNull();
  });

  it('refuses an invalid endDate with a 400 and changes nothing', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2027-06-30' });
    const res = await put(c, { id, endDate: '2027-02-30', templateName: 'should not apply' });
    expect(res.state.statusCode).toBe(400);
    expect(await row(id)).toMatchObject({ end_date: '2027-06-30' });
    expect((await row(id)).template_name).not.toBe('should not apply');
  });
});

describe('PUT recurring-invoices: tax basis', () => {
  it('editing the lines of a 0% template without taxRate keeps tax at 0', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 0 });
    const res = await put(c, { id, lineItems: lines(600) });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ subtotal: 1200, tax_rate: 0, tax_amount: 0, total_amount: 1200 });
  });

  it('the edited 0% template still runs (the header agrees with its tax_rate)', async () => {
    const { c, customer } = await fixture(true);
    const id = await template(c, customer, { taxRate: 0, due: true });
    expect((await put(c, { id, lineItems: lines(600) })).state.statusCode).toBe(200);
    const res = await callRoute(recurringRun, tokens[user]!, c, 'POST', { recurring_invoice_id: id },
      '/api/accounting/recurring-invoices-run');
    const out = dataOf<{ generated: number; errors: string[]; invoice_ids: string[] }>(res);
    expect(out.errors).toEqual([]);
    expect(out.generated).toBe(1);
    const inv = (await pool.query('SELECT tax_amount::float AS tax, total_amount::float AS total FROM customer_invoices WHERE id = $1',
      [out.invoice_ids[0]])).rows[0];
    expect(inv).toEqual({ tax: 0, total: 1200 });
  });

  it('keeps a stored non-standard rate (14%) when taxRate is omitted', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 14 });
    expect((await put(c, { id, lineItems: lines(500) })).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ subtotal: 1000, tax_rate: 14, tax_amount: 140, total_amount: 1140 });
  });

  it('an explicit taxRate (including 0) is applied and stored', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    expect((await put(c, { id, lineItems: lines(500), taxRate: 0 })).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ tax_rate: 0, tax_amount: 0, total_amount: 1000 });
  });

  it('refuses taxRate without lineItems and an out-of-range rate', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    expect((await put(c, { id, taxRate: 0 })).state.statusCode).toBe(400);
    expect((await put(c, { id, lineItems: lines(500), taxRate: 150 })).state.statusCode).toBe(400);
    expect(await row(id)).toMatchObject({ tax_rate: 15, tax_amount: 150, total_amount: 1150 });
  });
});

describe('PUT recurring-invoices: tenancy', () => {
  it("another company's PUT is a 404 and changes nothing", async () => {
    const a = await fixture();
    const b = await fixture();
    const id = await template(a.c, a.customer, { taxRate: 0 });
    const res = await put(b.c, { id, endDate: '2027-03-31', lineItems: lines(900) });
    expect(res.state.statusCode).toBe(404);
    expect(await row(id)).toMatchObject({ end_date: null, subtotal: 1000, tax_rate: 0, tax_amount: 0 });
  });
});

describe('PUT recurring-invoices: review findings', () => {
  it.each(['cancelled', 'completed'])('refuses to edit a %s template (409) instead of reporting a no-op as success', async (status) => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, status });
    const res = await put(c, { id, templateName: 'should not apply', endDate: '2027-12-31' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(await row(id)).toMatchObject({ status, end_date: null });
    expect((await row(id)).template_name).not.toBe('should not apply');
  });

  it('still edits a paused template', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, status: 'paused' });
    expect((await put(c, { id, templateName: 'paused edit' })).state.statusCode).toBe(200);
    expect((await row(id)).template_name).toBe('paused edit');
  });

  it('answers 503 when the template row is held past the lock timeout, and changes nothing', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM recurring_invoices WHERE id = $1 FOR UPDATE', [id]);
      const res = await put(c, { id, templateName: 'blocked' });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(503);
      expect(JSON.stringify(res.state.body)).toMatch(/locked by another request \(a run or another edit\) — retry the edit in a moment/);
      expect(JSON.stringify(res.state.body)).not.toMatch(/being run by another request/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await row(id)).template_name).not.toBe('blocked');
  });

  it.each([7.555, 14.999])('refuses a rate with more than 2 decimals (%j) and changes nothing', async (taxRate) => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const res = await put(c, { id, lineItems: lines(5000), taxRate });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await row(id)).toMatchObject({ subtotal: 1000, tax_rate: 15, tax_amount: 150 });
  });

  it('a 2-decimal rate on a R10 000 line stores a header the run accepts (7.55% = R755.00)', async () => {
    const { c, customer } = await fixture(true);
    const id = await template(c, customer, { taxRate: 15, due: true });
    const res = await put(c, { id, lineItems: [{ description: 'Big', quantity: 1, unitPrice: 10000 }], taxRate: 7.55 });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ tax_rate: 7.55, tax_amount: 755, total_amount: 10755 });
    const out = dataOf<{ generated: number; errors: string[] }>(await callRoute(recurringRun, tokens[user]!, c, 'POST',
      { recurring_invoice_id: id }, '/api/accounting/recurring-invoices-run'));
    expect(out.errors).toEqual([]);
    expect(out.generated).toBe(1);
  });

  it('refuses an End Date before the stored next run date', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 }); // next run = today + 30
    const res = await put(c, { id, endDate: '2020-01-01' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect((await row(id)).end_date).toBeNull();
  });

  it('judges the End Date against the next run date in the same body', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const refused = await put(c, { id, nextRunDate: '2031-06-01', endDate: '2031-05-31' });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(400);
    const sameDay = await put(c, { id, nextRunDate: '2031-06-01', endDate: '2031-06-01' });
    expect(sameDay.state.statusCode, JSON.stringify(sameDay.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ end_date: '2031-06-01' });
    // An early next run in the body makes an otherwise-early End Date valid.
    const early = await put(c, { id, nextRunDate: '2020-01-01', endDate: '2020-06-01' });
    expect(early.state.statusCode, JSON.stringify(early.state.body)).toBe(200);
  });

  it('refuses a next run date past the STORED End Date (the run would complete it without billing)', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2031-01-01' });
    const before = (await row(id)).next_run_date;
    const res = await put(c, { id, nextRunDate: '2031-06-01' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await row(id)).toMatchObject({ next_run_date: before, end_date: '2031-01-01' });
    // Clearing the End Date in the same body makes the move valid.
    const ok = await put(c, { id, nextRunDate: '2031-06-01', endDate: null });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ next_run_date: '2031-06-01', end_date: null });
  });

  it('does not judge an edit that touches neither date, even on a legacy template whose End Date is early', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2020-01-01' });
    expect((await put(c, { id, templateName: 'legacy rename' })).state.statusCode).toBe(200);
  });

  it('MEDIUM: a legacy template (End Date before next run) can still be renamed with its dates resent unchanged, as the edit page does', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2020-01-01' });
    const { next_run_date, end_date } = await row(id);
    const same = await put(c, { id, nextRunDate: next_run_date, templateName: 'legacy rename' });
    expect(same.state.statusCode, JSON.stringify(same.state.body)).toBe(200);
    const both = await put(c, { id, nextRunDate: next_run_date, endDate: end_date, templateName: 'legacy rename 2' });
    expect(both.state.statusCode, JSON.stringify(both.state.body)).toBe(200);
    expect(await row(id)).toMatchObject({ template_name: 'legacy rename 2', next_run_date, end_date });
  });

  it('MEDIUM: the same legacy template refuses a CHANGED next run date', async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15, endDate: '2020-01-01' });
    const before = await row(id);
    const res = await put(c, { id, nextRunDate: '2031-06-01', templateName: 'should not apply' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await row(id)).toMatchObject({ next_run_date: before.next_run_date, template_name: before.template_name });
  });

  it.each(['garbage', '2031-02-30', '2031-06-01T00:00:00Z'])('refuses a malformed nextRunDate %j and changes nothing', async (nextRunDate) => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const before = (await row(id)).next_run_date;
    const res = await put(c, { id, nextRunDate, templateName: 'should not apply' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await row(id)).toMatchObject({ next_run_date: before });
    expect((await row(id)).template_name).not.toBe('should not apply');
  });

  it("a blank nextRunDate keeps the stored one, as before", async () => {
    const { c, customer } = await fixture();
    const id = await template(c, customer, { taxRate: 15 });
    const before = (await row(id)).next_run_date;
    expect((await put(c, { id, nextRunDate: '', templateName: 'blank date' })).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ next_run_date: before, template_name: 'blank date' });
  });
});
