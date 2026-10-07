/**
 * R-035 PR6: the recurring journal runs are unattended — nobody decides at the
 * moment they fire — so neither may refuse a gated journal: a refusal rolled
 * the journal back with the schedule, and the template stalled on every run.
 *
 *  - recurring journals ('generate'): a gated template's journal is left a
 *    DRAFT, marked, with the request raised as the runner; the schedule still
 *    advances and the answer lists it in heldForApproval. An ungated template
 *    posts (marked) and lists nothing.
 *  - The template's authors — its creator and every user whose PUT changed what
 *    it posts — are the journal's authors too: refused as its approvers, while
 *    an owner who wrote nothing approves it.
 *  - recurring-transaction autoPost of a journal: the same hold, posted:false,
 *    the schedule advanced, the template's authors unioned in.
 *  - Enforcement off: everything posts as before and writes no 869 column on
 *    the journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringJournalsAction from '../../pages/api/accounting/recurring-journals-action';
import recurringJournals from '../../pages/api/accounting/recurring-journals';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, type JournalCompany,
} from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', m: '' };
const r = journalRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

/** A (admin) runs; B and C (owners) approve; M (manager) edits. Owner rule over R1 000. */
async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.m, 'manager']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

const lines = (f: JournalCompany, amount: number) => [
  { glAccountId: f.expA, debit: amount, credit: 0, description: 'rent' },
  { glAccountId: f.bank, debit: 0, credit: amount, description: 'bank' },
];

/** A monthly recurring journal due three days ago, created by `by`: R1 500 (gated) or R900 (not). */
async function template(f: JournalCompany, gated: boolean, by = u.a): Promise<string> {
  const id = crypto.randomUUID();
  const amount = gated ? 1500 : 900;
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,description,frequency,next_run_date,lines,total_amount,created_by)
     VALUES($1,$2,$3,'R035 rent','monthly',CURRENT_DATE - INTERVAL '3 days',$4::jsonb,$5,$6)`,
    [id, f.c, `R035 ${id.slice(0, 6)}`, JSON.stringify(lines(f, amount)), amount, by]);
  return id;
}
const generate = (c: string, id: string) => callRoute(recurringJournalsAction, tokens[u.a]!, c, 'POST',
  { action: 'generate', id }, '/api/accounting/recurring-journals-action');
const schedule = async (id: string) => (await pool.query(
  'SELECT next_run_date > CURRENT_DATE AS advanced, run_count FROM recurring_journals WHERE id = $1', [id])).rows[0];
const pendingOf = async (journalId: string) => (await pool.query(
  "SELECT id, requested_by, document_digest FROM approval_requests WHERE document_id = $1 AND status = 'pending'", [journalId])).rows;
const decide = (user: string, c: string, req: { id: string; document_digest: string }) => r.decide(pool, user, c, req.id);

describe("recurring journals ('generate')", () => {
  it('holds a gated journal as a marked draft with a request by the runner, and advances the schedule', async () => {
    const f = await fixture();
    const id = await template(f, true);
    const res = await generate(f.c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { journalId, heldForApproval } = dataOf<{ journalId: string; heldForApproval: string[] }>(res);
    expect(heldForApproval).toEqual([journalId]);
    expect(await journalState(pool, journalId)).toMatchObject({ status: 'draft', marker: 'manual_journal', posted_debit: 0 });
    expect((await pendingOf(journalId)).map((p) => p.requested_by)).toEqual([u.a]);
    expect(await schedule(id)).toEqual({ advanced: true, run_count: 1 });
    expect((await generate(f.c, id)).state.statusCode).toBe(400);
  });

  it('posts an ungated journal, marked, and holds nothing', async () => {
    const f = await fixture();
    const id = await template(f, false);
    const { journalId, heldForApproval } = dataOf<{ journalId: string; heldForApproval: string[] }>(await generate(f.c, id));
    expect(heldForApproval).toEqual([]);
    expect(await journalState(pool, journalId)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
    expect(await schedule(id)).toEqual({ advanced: true, run_count: 1 });
  });

  it("the template's creator and its editors may not approve the journal it minted; an owner who wrote nothing may", async () => {
    const f = await fixture();
    const id = await template(f, true, u.c);
    const put = await callRoute(recurringJournals, tokens[u.m]!, f.c, 'PUT', { id, description: 'R035 rent (revised)' },
      '/api/accounting/recurring-journals');
    expect(put.state.statusCode).toBe(200);
    expect((await pool.query('SELECT content_authors::TEXT[] AS a FROM recurring_journals WHERE id = $1', [id])).rows[0].a)
      .toEqual([u.m]);
    const { journalId } = dataOf<{ journalId: string }>(await generate(f.c, id));
    expect((await journalState(pool, journalId)).authors.sort()).toEqual([u.c, u.m].sort());
    const [req] = await pendingOf(journalId);
    const refused = await decide(u.c, f.c, req);
    expect(refused.state.statusCode).toBe(403);
    expect(messageOf(refused)).toMatch(/you authored the content it covers \(you created the journal/);
    expect((await decide(u.b, f.c, req)).state.statusCode).toBe(200);
    expect((await r.post(u.a, f.c, journalId)).state.statusCode).toBe(200);
  });

  it('enforcement off: posts as before, unmarked, no authors stamped, nothing held', async () => {
    const f = await fixture({ enforced: false });
    const id = await template(f, true, u.c);
    const { journalId, heldForApproval } = dataOf<{ journalId: string; heldForApproval: string[] }>(await generate(f.c, id));
    expect(heldForApproval).toEqual([]);
    expect(await journalState(pool, journalId)).toMatchObject({ status: 'posted', marker: null, authors: [] });
  });
});

describe('recurring-transaction autoPost of a journal', () => {
  async function txTemplate(f: JournalCompany, amount: number, by: string): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,next_run_date,auto_post,created_by,content_authors)
       VALUES($1,$2,'R035 JE auto-post','journal_entry',$3,'monthly',CURRENT_DATE,true,$4,ARRAY[$5::UUID])`,
      [id, f.c, JSON.stringify({ description: 'R035 accrual', lines: lines(f, amount) }), by, u.m]);
    return id;
  }
  const execute = (c: string, templateId: string) => callRoute(recurringExecute, tokens[u.a]!, c, 'POST', { templateId },
    '/api/accounting/recurring-transactions-execute');
  const advanced = async (id: string) => (await pool.query(
    'SELECT next_run_date > CURRENT_DATE AS advanced FROM recurring_transaction_templates WHERE id = $1', [id])).rows[0].advanced;

  it('holds a gated journal: draft, marked, request by the runner, posted:false, listed, schedule advanced', async () => {
    const f = await fixture();
    const id = await txTemplate(f, 1500, u.c);
    const res = await execute(f.c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const result = dataOf<{ entityId: string; posted: boolean; heldForApproval: string[] }>(res);
    expect(result).toMatchObject({ posted: false, heldForApproval: [result.entityId] });
    expect(await journalState(pool, result.entityId)).toMatchObject({ status: 'draft', marker: 'manual_journal' });
    expect((await journalState(pool, result.entityId)).authors.sort()).toEqual([u.c, u.m].sort());
    const [req] = await pendingOf(result.entityId);
    expect(req.requested_by).toBe(u.a);
    expect((await decide(u.c, f.c, req)).state.statusCode).toBe(403);
    expect(await advanced(id)).toBe(true);
  });

  it('posts an ungated journal, marked, holding nothing', async () => {
    const f = await fixture();
    const result = dataOf<{ entityId: string; posted: boolean; heldForApproval: string[] }>(await execute(f.c, await txTemplate(f, 900, u.a)));
    expect(result).toMatchObject({ posted: true, heldForApproval: [] });
    expect(await journalState(pool, result.entityId)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });
});
