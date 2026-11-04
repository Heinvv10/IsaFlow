/**
 * Budgets P5-2: the budget check on the recurring auto-post path (system channel, lock-free:
 * the run already holds the template row, its accounts and the document number). Real
 * PostgreSQL as app_user through `executeRecurring`, which mints the bill dated today and
 * approves it. Block over budget: the bill stays a draft, the run reports why and the refused
 * event (channel system) is kept; warn: the bill posts and the run reports the overspend.
 * The fixture budgets travel at company level, 500 a month; when today is outside the fixture's
 * FY2027 a primary budget is added for today's registry year. Fixture route:
 * isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import { ensureDocumentNumbers } from '@/modules/accounting/services/core/companySettingsService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, dropBillFixture, eventsFor, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;

/** Today's month must carry a travel budget of 500 in a primary version. */
async function budgetToday(): Promise<void> {
  const y = (await pool.query(`SELECT fiscal_year, start_date::TEXT AS s, end_date::TEXT AS e
                                  FROM public.fiscal_year_for_date($1, CURRENT_DATE)`, [f.co])).rows[0];
  if (Number(y.fiscal_year) === 2027) return;
  await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
                    VALUES ($1, $2, $3, $4, 'normal') ON CONFLICT DO NOTHING`, [f.co, y.fiscal_year, y.s, y.e]);
  const v = String((await pool.query(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
    VALUES ($1, $2, 'Original', 'original', true, $3) RETURNING id`, [f.co, y.fiscal_year, f.owner])).rows[0].id);
  await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
                    VALUES ($1, $2, $3, date_trunc('month', CURRENT_DATE)::DATE, 500)`, [f.co, v, f.acc.travel]);
}

beforeAll(async () => {
  f = await seedBillFixture(pool, 'recurring');
  await budgetToday();
  await ensureDocumentNumbers(f.co);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally {
    await pool.end();
  }
}, 60_000);

/** An auto-posting bill template: one travel line of 800 net (the month's budget is 500). */
async function template(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type, template_data, frequency, auto_post, created_by)
     VALUES ($1, $2, $3, 'supplier_invoice', $4, 'monthly', true, $5)`,
    [id, f.co, `P5-2 rec ${id.slice(0, 6)}`, JSON.stringify({
      supplierId: f.supplier,
      lines: [{ description: 'Flights', quantity: 1, unitPrice: 800, taxRate: 15, lineTotal: 800, accountId: f.acc.travel }],
    }), f.owner]);
  return id;
}

async function run(templateId: string) {
  const req = await openRequest(pool, f, f.owner);
  try {
    const out = await req.run(() => executeRecurring(f.co, templateId, f.owner));
    await req.commit();
    return out;
  } finally {
    await req.rollback();
  }
}

describe('recurring auto-post', () => {
  it('block, over budget: the bill stays a draft with the reason, the refused event (system) is kept, the schedule advances', async () => {
    await setPolicy(pool, f, 'block');
    const tpl = await template();
    const out = await run(tpl);
    expect(out.posted).toBe(false);
    expect(out.warnings).toEqual([expect.stringMatching(/^Left as a draft: Over budget — approval refused: BB-6200 Travel · /)]);
    expect(await billState(pool, out.entityId)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    expect((await eventsFor(pool, out.entityId)).map((e) => [e.outcome, e.channel, e.policy])).toEqual([['refused', 'system', 'block']]);
    const next = (await pool.query('SELECT last_run_date IS NOT NULL AS ran FROM recurring_transaction_templates WHERE id = $1', [tpl])).rows[0];
    expect(next.ran).toBe(true);
  });

  it('warn, over budget: posted, the overspend reported, event warn (system)', async () => {
    await setPolicy(pool, f, 'warn');
    const out = await run(await template());
    expect(out.posted).toBe(true);
    expect(out.warnings).toEqual([expect.stringMatching(/^Over budget: BB-6200 Travel · /)]);
    expect((await billState(pool, out.entityId)).status).toBe('approved');
    expect(await eventsFor(pool, out.entityId)).toEqual([expect.objectContaining({ outcome: 'warn', channel: 'system', reason: null })]);
  });
});
