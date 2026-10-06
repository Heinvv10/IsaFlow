/**
 * R-035 PR4: who is an author of the time billed on a customer invoice (Hein,
 * 2026-10-06: the rate sets the price; rounds 2 and 3).
 *
 *  - Time tracking (POST /time-entries): the person who logs an entry TYPES its
 *    rate, so a logger who stores a rate is an author (round 3, R-D).
 *  - Practice timesheets: the rate is resolved from the rate tables, so the
 *    logger is no author (decision 1). Whoever sets those tables is not one
 *    either: they are configuration — a recorded limit (migration 865).
 *  - Either path: a user who changes an entry's rate or billable flag is an
 *    author; so is one who changes SOMEONE ELSE'S hours, which re-quantifies
 *    their effort and sets the billed amount (round 3, R-E). Your own hours
 *    stay effort and stamp nothing.
 *  - Practice duplicate: a copy of SOMEONE ELSE'S entry adds billable hours
 *    under their name, so its copier is an author of it; copying your own
 *    entry is effort (round 4, REPRO F).
 * An author is refused 403 as the approver while another eligible one exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import timeEntries from '../../pages/api/accounting/time-entries';
import timeEntriesInvoice from '../../pages/api/accounting/time-entries-invoice';
import duplicateRoute from '../../pages/api/accounting/practice/time-entries/duplicate';
import { createPracticeEntry, updatePracticeEntry } from '../../src/modules/accounting/services/practice/practiceTimeEntryService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr4, enforceInvoices, invoiceCompany, invoiceRoutes } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** alice: admin who invoices and raises; bob: owner; carol: a second owner. */
const u = { alice: '', bob: '', carol: '' };
const r = invoiceRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM practice_staff_rates WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM practice_client_rate_overrides WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM time_entries WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM practice_work_items WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM practice_job_categories WHERE company_id = ANY($1)', [companies]);
  await cleanupPr4(pool, companies, Object.values(u));
});

async function fixture() {
  const c = await invoiceCompany(pool, [[u.alice, 'admin'], [u.bob, 'owner'], [u.carol, 'owner']], companies);
  await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 1000 });
  await enforceInvoices(pool, c, u.carol);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'R035 time')", [customer, c]);
  return { c, customer };
}

const call = (user: string, c: string, method: string, body: Record<string, unknown>, url = '/api/accounting/time-entries') =>
  callRoute((url.endsWith('invoice') ? timeEntriesInvoice : timeEntries) as never, tokens[user]!, c, method, body, url);
const ok = <T>(res: Awaited<ReturnType<typeof callRoute>>): T => {
  expect([200, 201], JSON.stringify(res.state.body)).toContain(res.state.statusCode);
  return dataOf<T>(res);
};
const log = async (user: string, c: string, customer: string, rate: number, extra: Record<string, unknown> = {}) =>
  ok<{ id: string }>(await call(user, c, 'POST', { taskDescription: 'Advice', hours: 1, rate, billable: true, customerId: customer, ...extra })).id;
const stamped = async (id: string) => ((await pool.query(
  'SELECT content_authors::TEXT[] AS a FROM time_entries WHERE id = $1', [id])).rows[0].a as string[]).sort();
const invoice = async (c: string, customer: string, ids: string[]) => ok<{ invoiceId: string }>(await call(u.alice, c, 'POST',
  { timeEntryIds: ids, customerId: customer }, '/api/accounting/time-entries-invoice')).invoiceId;

/** alice raises; `refused` gets 403 as an author; `approver` approves. */
async function refusedThenApproved(c: string, invoiceId: string, refused: string, approver: string): Promise<void> {
  const requestId = ok<{ id: string }>(await r.raise(u.alice, c, invoiceId)).id;
  const res = await r.decide(pool, refused, c, requestId);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(403);
  expect(messageOf(res)).toMatch(/you authored the content/);
  expect((await r.decide(pool, approver, c, requestId)).state.statusCode).toBe(200);
}

describe('time tracking: the logger types the rate (R-D)', () => {
  it('bob logs his own entry at R100 000/h; alice invoices it; bob is refused, carol approves', async () => {
    const { c, customer } = await fixture();
    const entry = await log(u.bob, c, customer, 100_000);
    expect(await stamped(entry)).toEqual([u.bob]);
    await refusedThenApproved(c, await invoice(c, customer, [entry]), u.bob, u.carol);
  });

  it('an entry logged with no rate makes nobody an author, nor do its logger\'s own hours', async () => {
    const { c, customer } = await fixture();
    const entry = ok<{ id: string }>(await call(u.bob, c, 'POST',
      { taskDescription: 'Advice', hours: 1, billable: true, customerId: customer })).id;
    expect(await stamped(entry)).toEqual([]);
    ok(await call(u.bob, c, 'PUT', { id: entry, hours: 3 }));
    expect(await stamped(entry)).toEqual([]);
  });
});

describe('time tracking: editors', () => {
  it("bob raises the rate on alice's entry; alice invoices; bob is refused, carol approves (REPRO C)", async () => {
    const { c, customer } = await fixture();
    const entry = await log(u.alice, c, customer, 100);
    ok(await call(u.bob, c, 'PUT', { id: entry, rate: 100_000 }));
    expect(await stamped(entry)).toEqual([u.alice, u.bob].sort());
    await refusedThenApproved(c, await invoice(c, customer, [entry]), u.bob, u.carol);
  });

  it("your own hours are effort; bob changing alice's hours re-prices them and makes him an author (R-E)", async () => {
    const { c, customer } = await fixture();
    const entry = await log(u.alice, c, customer, 100);
    ok(await call(u.alice, c, 'PUT', { id: entry, hours: 2, taskDescription: 'More advice' }));
    expect(await stamped(entry)).toEqual([u.alice]);
    ok(await call(u.bob, c, 'PUT', { id: entry, hours: 1000 }));
    expect(await stamped(entry)).toEqual([u.alice, u.bob].sort());
    await refusedThenApproved(c, await invoice(c, customer, [entry]), u.bob, u.carol);
  });

  it('turning an entry billable stamps the user who did', async () => {
    const { c, customer } = await fixture();
    const entry = await log(u.alice, c, customer, 100, { billable: false });
    ok(await call(u.bob, c, 'PUT', { id: entry, billable: true }));
    expect(await stamped(entry)).toEqual([u.alice, u.bob].sort());
  });
});

/** A practice company: clients A and B (B carries carol's R5000 override), carol's R850 staff rate. */
async function practice(c: string) {
  const [clientA, clientB, category, item] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status)
     VALUES($1,$3,'R035 A','hourly','active'),($2,$3,'R035 B','hourly','active')`, [clientA, clientB, c]);
  await pool.query('INSERT INTO practice_job_categories(id,company_id,name) VALUES($1,$2,$3)', [category, c, 'R035 cat']);
  await pool.query('INSERT INTO practice_work_items(id,company_id,category_id,name) VALUES($1,$2,$3,$4)', [item, c, category, 'R035 item']);
  await pool.query("INSERT INTO practice_staff_rates(company_id,user_id,rate,effective_from) VALUES($1,$2,850,'2020-01-01')", [c, u.carol]);
  await pool.query(
    `INSERT INTO practice_client_rate_overrides(company_id,client_id,staff_user_id,user_id,rate_per_hour,rate,effective_from)
     VALUES($1,$2,$3,$3,5000,5000,'2020-01-01')`, [c, clientB, u.carol]);
  const inTx = async <T>(user: string, fn: () => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: user, companyId: c, claims: { sub: user } } as never, fn);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const logCarol = () => inTx(u.carol, () => createPracticeEntry(c, u.carol, {
    entryDate: '2026-01-05', hours: 2, practiceClientId: clientA, jobCategoryId: category, workItemId: item, taskDescription: 'Audit',
  }));
  return { clientB, inTx, logCarol };
}

describe('practice timesheets: the rate comes from the rate tables', () => {
  it('the logger is no author; a re-pricing editor and an editor of someone else\'s hours are', async () => {
    const { c } = await fixture();
    const { clientB, inTx, logCarol } = await practice(c);
    const entry = await logCarol();
    expect(await stamped(entry.id)).toEqual([]); // the logger: the rate came from the table
    await inTx(u.carol, () => updatePracticeEntry(c, entry.id, { hours: 3 }, u.carol));
    expect(await stamped(entry.id)).toEqual([]); // her own hours: effort
    await inTx(u.alice, () => updatePracticeEntry(c, entry.id, { hours: 4 }, u.alice));
    expect(await stamped(entry.id)).toEqual([u.alice]); // someone else's hours (R-E)
    await inTx(u.bob, () => updatePracticeEntry(c, entry.id, { practiceClientId: clientB }, u.bob));
    expect(await stamped(entry.id)).toEqual([u.alice, u.bob].sort()); // re-priced from the override
    const { rows: [row] } = await pool.query('SELECT applied_rate::FLOAT8 AS rate FROM time_entries WHERE id = $1', [entry.id]);
    expect(row.rate).toBe(5000);
  });

  it("duplicating your own entry is effort; bob duplicating carol's makes him its author, refused on the invoice (REPRO F)", async () => {
    const { c, customer } = await fixture();
    const { logCarol } = await practice(c);
    const entry = (await logCarol()).id;
    const duplicate = async (user: string, newDate: string) => ok<{ id: string; userId: string }>(await callRoute(
      duplicateRoute as never, tokens[user]!, c, 'POST', { id: entry, newDate }, '/api/accounting/practice/time-entries/duplicate'));
    const own = await duplicate(u.carol, '2026-01-06');
    expect(await stamped(own.id)).toEqual([]);
    const copy = await duplicate(u.bob, '2026-01-07');
    expect(copy.userId).toBe(u.carol); // still carol's time, under her rate
    expect(await stamped(copy.id)).toEqual([u.bob]);
    expect(await stamped(entry)).toEqual([]); // the source is untouched
    await refusedThenApproved(c, await invoice(c, customer, [entry, own.id, copy.id]), u.bob, u.carol);
  });
});
