/**
 * Forensic-controls step 2, E (Hein, 2026-10-09, decision 6): Banking > Transfers under manual-journal enforcement.
 *
 * A transfer a rule matches is no longer refused: it is saved as a DRAFT journal (the same two bank legs, marked
 * manual_journal, created by the person) and an approval request is raised as the person — the existing
 * manual-journal draft -> request -> approve -> post flow. The route answers 202 `awaiting_approval` with the
 * journal and request ids. Nothing posts until another member approves and the journal is posted through
 * journal-entries-action. The 428 duplicate confirmation still runs first; Login-as is still refused before any
 * write; with enforcement off, or below the rule, the transfer posts at once as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import { allocateTransaction } from '../../src/modules/accounting/services/bank/bankAllocationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { inRequest } from './r035-pr5.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const routes = journalRoutes(tokens);

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
});
afterAll(async () => { await cleanupPr6(pool, companies, [a, b]); });

type Company = JournalCompany & { bank2: string };

/** Two admins, a second bank account, an admin rule over R1 000 on manual journals; enforced unless told otherwise. */
async function fixture(opts: { enforced?: boolean } = {}): Promise<Company> {
  const f = await journalCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES($1,$2,'R035 Savings','asset','debit',true,'bank') RETURNING id`, [f.c, `S2${f.c.slice(0, 6)}`]);
  await journalRule(plantRule, pool, f.c, { role: 'admin' });
  if (opts.enforced !== false) await enforceJournals(pool, f.c, a);
  return { ...f, bank2: String(rows[0].id) };
}

const transfer = (f: Company, body: Record<string, unknown> = {}, token = tokens[a]!) => callRoute(bankTransfers, token, f.c, 'POST',
  { fromAccountId: f.bank, toAccountId: f.bank2, amount: 1500, transferDate: '2026-09-01', reference: 'Float top-up', ...body },
  '/api/accounting/bank-transfers');
const journals = async (c: string) => (await pool.query(
  `SELECT id::TEXT, status, source, reference, description, created_by::TEXT AS created_by, approval_document_type AS marker
   FROM gl_journal_entries WHERE company_id = $1 ORDER BY created_at, id`, [c])).rows;
const requests = async (c: string) => (await pool.query(
  `SELECT id::TEXT, status, requested_by::TEXT AS requested_by, document_type, document_id::TEXT AS document_id
   FROM approval_requests WHERE company_id = $1 ORDER BY requested_at`, [c])).rows;
const legs = async (journalId: string) => (await pool.query(
  `SELECT gl_account_id::TEXT AS account, debit::FLOAT8 AS debit, credit::FLOAT8 AS credit FROM gl_journal_lines
   WHERE journal_entry_id = $1 ORDER BY debit DESC`, [journalId])).rows;
/** Net posted movement per bank account (the balance cache the post maintains). */
const moved = async (f: Company) => Object.fromEntries((await pool.query(
  `SELECT gl_account_id::TEXT AS account, SUM(debit_total - credit_total)::FLOAT8 AS net FROM gl_account_balances
   WHERE gl_account_id = ANY($1::UUID[]) GROUP BY gl_account_id`, [[f.bank, f.bank2]])).rows
  .filter((r) => r.net !== 0).map((r) => [r.account === f.bank ? 'from' : 'to', r.net]));
const status = (res: { state: { statusCode: number; body: unknown } }) => res.state.statusCode;

type Held = { status: string; journalId: string; requestId: string; requiredRole: string };

describe('under manual-journal enforcement, a transfer a rule matches', () => {
  it('is saved as a draft journal marked manual_journal with a request raised by the person; nothing posts', async () => {
    const f = await fixture();
    const res = await transfer(f);
    expect(status(res), JSON.stringify(res.state.body)).toBe(202);
    const held = dataOf<Held>(res);
    expect(held).toMatchObject({ status: 'awaiting_approval', requiredRole: 'admin' });
    const message = (res.state.body as { message?: string }).message ?? '';
    expect(message).toMatch(/saved as a draft journal awaiting admin approval/);
    expect(message).toMatch(/match the statement line to this journal rather than allocating it as a transfer/);
    const [je, ...others] = await journals(f.c);
    expect(others).toEqual([]);
    expect(je).toMatchObject({ id: held.journalId, status: 'draft', source: 'auto_bank_transfer', marker: 'manual_journal',
      created_by: a, reference: 'Transfer: R035 BK -> R035 Savings', description: 'Float top-up' });
    expect(await legs(held.journalId)).toEqual([
      { account: f.bank2, debit: 1500, credit: 0 }, { account: f.bank, debit: 0, credit: 1500 },
    ]);
    expect(await requests(f.c)).toEqual([{ id: held.requestId, status: 'pending', requested_by: a,
      document_type: 'manual_journal', document_id: held.journalId }]);
    expect(await moved(f)).toEqual({});
  });

  it('posts only after another member approves: the requester may not approve their own; then the creator posts it', async () => {
    const f = await fixture();
    const held = dataOf<Held>(await transfer(f));
    const early = await routes.post(a, f.c, held.journalId);
    expect(status(early), 'posting before approval').toBe(409);
    const own = await routes.decide(pool, a, f.c, held.requestId);
    expect(status(own), JSON.stringify(own.state.body)).toBe(403);
    expect(status(await routes.decide(pool, b, f.c, held.requestId))).toBe(200);
    expect(await moved(f)).toEqual({});
    const posted = await routes.post(a, f.c, held.journalId);
    expect(status(posted), JSON.stringify(posted.state.body)).toBe(200);
    expect((await journals(f.c))[0]).toMatchObject({ status: 'posted', marker: 'manual_journal' });
    expect(await moved(f)).toEqual({ from: -1500, to: 1500 });
  });

  it('meets the duplicate guard first: 428 with no draft and no request; confirmed, it is held as a draft', async () => {
    const f = await fixture({ enforced: false });
    const { rows } = await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
       VALUES($1,$2,DATE '2026-08-31',-1500,'R035 stmt transfer','imported',gen_random_uuid()) RETURNING id`, [f.c, f.bank]);
    await inRequest(pool, a, f.c, () => allocateTransaction(f.c, String(rows[0].id), f.bank2, a, 'R035 stmt', 'transfer'));
    await enforceJournals(pool, f.c, a);
    const before = (await journals(f.c)).length;
    const dup = await transfer(f);
    expect(status(dup), JSON.stringify(dup.state.body)).toBe(428);
    expect((await journals(f.c)).length).toBe(before);
    expect(await requests(f.c)).toEqual([]);
    const confirmed = await transfer(f, { confirmDuplicate: true });
    expect(status(confirmed), JSON.stringify(confirmed.state.body)).toBe(202);
    expect((await journals(f.c)).at(-1)).toMatchObject({ status: 'draft', marker: 'manual_journal' });
    expect(await requests(f.c)).toHaveLength(1);
  });

  it('from a Login-as session is refused 403 with no draft and no request', async () => {
    const f = await fixture();
    const res = await transfer(f, {}, await impersonationToken(pool, a, b));
    expect(status(res)).toBe(403);
    expect(JSON.stringify(res.state.body)).toMatch(/impersonating/);
    expect(await journals(f.c)).toEqual([]);
    expect(await requests(f.c)).toEqual([]);
  });
});

describe('otherwise the transfer posts at once, as before', () => {
  it('enforcement off: one posted journal, no request', async () => {
    const f = await fixture({ enforced: false });
    const res = await transfer(f);
    expect(status(res), JSON.stringify(res.state.body)).toBe(200);
    expect((await journals(f.c)).map((j) => [j.status, j.marker])).toEqual([['posted', null]]);
    expect(await requests(f.c)).toEqual([]);
    expect(await moved(f)).toEqual({ from: -1500, to: 1500 });
  });

  it('below the rule: one posted journal, no request', async () => {
    const f = await fixture();
    const res = await transfer(f, { amount: 400 });
    expect(status(res), JSON.stringify(res.state.body)).toBe(200);
    expect((await journals(f.c)).map((j) => j.status)).toEqual(['posted']);
    expect(await requests(f.c)).toEqual([]);
    expect(await moved(f)).toEqual({ from: -400, to: 400 });
  });
});
