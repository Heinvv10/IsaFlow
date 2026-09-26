/**
 * K-061 review round 3: "run all due" (POST /api/accounting/recurring-invoices-run)
 * holds every template it has run FOR UPDATE until the request ends, and a
 * customer merge locks the same customer's templates ORDER BY id. It used to
 * walk them by next_run_date, so two templates whose due-date order and id
 * order disagree were locked in the inverse order to a merge: a 40P01 cycle.
 * It still CHOOSES by due date (the batch cap) but now processes in id order;
 * pinned here by outcome, through the real route.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringRun from '../../pages/api/accounting/recurring-invoices-run';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k061 } from './k061-customer-merge.helpers';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);

// Posting a generated invoice needs an open period and the AR/revenue/VAT
// system accounts (same seed as k107-recurring-autopost-and-footing).
beforeAll(async () => {
  await h.setUp();
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'K061 run year',1,EXTRACT(YEAR FROM CURRENT_DATE)::int,
            date_trunc('year',CURRENT_DATE)::date,(date_trunc('year',CURRENT_DATE)+INTERVAL '1 year -1 day')::date,'open')`,
    [h.companyA]);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES
      ($1,'K1100','Accounts receivable','asset','receivable','debit',true,true),
      ($1,'K4000','Sales','revenue','default_revenue','credit',true,true),
      ($1,'K2200','VAT output','liability','vat_output','credit',true,true)`, [h.companyA]);
  clearSystemAccountCache();
});

async function clearRuns() {
  await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [h.companyA]);
  await h.wipe();
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [h.companyA]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [h.companyA]);
}

afterAll(async () => {
  await clearRuns();
  // Balances are keyed by account and period; delete them by those, not company.
  await pool.query(
    `DELETE FROM gl_account_balances
     WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)
        OR fiscal_period_id IN (SELECT id FROM fiscal_periods WHERE company_id=$1)`, [h.companyA]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [h.companyA]);
  clearSystemAccountCache();
  await h.tearDown();
});
beforeEach(clearRuns);

async function template(id: string, due: string, amount: number, customer: string) {
  await pool.query(
    `INSERT INTO recurring_invoices(id,company_id,client_id,template_name,frequency,next_run_date,status,
       line_items,subtotal,tax_rate,tax_amount,total_amount,created_by)
     VALUES($1,$2,$3,$4,'monthly',$5,'active',$6::jsonb,$7,0,0,$7,$8)`,
    [id, h.companyA, customer, `K061 run ${amount}`, due,
      JSON.stringify([{ description: 'k061', quantity: 1, unitPrice: amount }]), amount, h.admin]);
}

it('runs due templates in id order, whatever their due dates', async () => {
  const customer = await h.customer(h.companyA, 'K061 Run Customer');
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  const [low, high] = a < b ? [a, b] : [b, a];
  await template(high, '2026-01-01', 11, customer); // due first, higher id
  await template(low, '2026-02-01', 22, customer);

  const result = await h.post(recurringRun as never, '/api/accounting/recurring-invoices-run', {});
  expect(result.state.statusCode).toBe(200);
  const data = (result.state.body as { data: { generated: number; invoice_ids: string[]; errors: string[] } }).data;
  expect(data.errors).toEqual([]);
  expect(data.generated).toBe(2);
  const totals: number[] = [];
  for (const id of data.invoice_ids) {
    const { rows } = await pool.query('SELECT total_amount::float8 AS t FROM customer_invoices WHERE id=$1', [id]);
    totals.push(rows[0].t);
  }
  expect(totals).toEqual([22, 11]); // the lower id ran first
});
