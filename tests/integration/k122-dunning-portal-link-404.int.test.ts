/**
 * K-122 — the dunning {{portal_link}} token renders a URL the portal rejects.
 *
 * renderTemplate (dunningService.ts:208-210) builds
 * `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}` — the invoice UUID. Both
 * the portal page (pages/portal/invoice/[token].tsx:517) and the portal API
 * (pages/api/portal/invoice/[token].ts:59) accept only a 64-hex portal_token
 * and return notFound for anything else. The token that would work comes from
 * getOrMintInvoicePortalToken, which this path never calls. All four SA default
 * templates embed {{portal_link}} (dunningDefaults.ts:42,61,79,102).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { renderTemplate } from '../../src/modules/accounting/services/ar/dunningService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const invoice = crypto.randomUUID(), template = crypto.randomUUID();

/** The only shape the portal route and page accept. */
const PORTAL_TOKEN = /^[a-f0-9]{64}$/;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K122 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name,email) VALUES($1,$2,$3,$4)', [customer, company, 'K122 customer', 'k122@test.local']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122-INV-1',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'approved',$4)`,
    [invoice, company, customer, user]);
  await pool.query(
    `INSERT INTO dunning_templates(id,company_id,name,days_overdue_min,subject_template,body_template)
     VALUES($1,$2,'K122 first reminder',1,'Invoice {{invoice_number}} is overdue','Pay online at {{portal_link}}')`,
    [template, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM dunning_templates WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('renders a portal link the portal route will actually serve', async () => {
  const rendered = await renderTemplate(company, template, invoice, 'https://app.isaflow.co.za');
  expect(rendered).not.toBeNull();

  const link = rendered!.body.replace('Pay online at ', '').trim();
  const lastSegment = link.split('/').pop()!;

  expect.soft(lastSegment).not.toBe(invoice); // it is the invoice UUID today
  expect(lastSegment).toMatch(PORTAL_TOKEN);
});

it('mints the token once — re-rendering reuses the stored portal_token', async () => {
  const first = await renderTemplate(company, template, invoice, 'https://app.isaflow.co.za');
  const second = await renderTemplate(company, template, invoice, 'https://app.isaflow.co.za');
  const seg = (r: { body: string }) => r.body.replace('Pay online at ', '').trim().split('/').pop();

  expect(seg(first!)).toBe(seg(second!));
  const { rows } = await pool.query('SELECT portal_token FROM customer_invoices WHERE id=$1', [invoice]);
  expect(seg(first!)).toBe(rows[0].portal_token);
});

it('keeps the fallback when no portal base URL is supplied', async () => {
  const rendered = await renderTemplate(company, template, invoice, undefined);
  expect(rendered!.body).toBe('Pay online at (portal link unavailable)');
});

it('falls back rather than throwing when the invoice is not portal-eligible', async () => {
  const cancelled = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,'K122-INV-CANCELLED',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,'cancelled',$4)`,
    [cancelled, company, customer, user]);

  const rendered = await renderTemplate(company, template, cancelled, 'https://app.isaflow.co.za');
  expect(rendered!.body).toBe('Pay online at (portal link unavailable)');
});

it('does not render another tenant’s invoice', async () => {
  const other = crypto.randomUUID(), otherTemplate = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K122 other tenant']);
  await pool.query(
    `INSERT INTO dunning_templates(id,company_id,name,days_overdue_min,subject_template,body_template)
     VALUES($1,$2,'K122 other reminder',1,'Overdue','Pay online at {{portal_link}}')`,
    [otherTemplate, other]);
  try {
    expect(await renderTemplate(other, otherTemplate, invoice, 'https://app.isaflow.co.za')).toBeNull();
  } finally {
    await pool.query('DELETE FROM dunning_templates WHERE company_id=$1', [other]);
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});
