/**
 * R-035 PR6 (Hein, 2026-10-07, decision (b)): the Month-End Workbench's
 * `post_draft_journal` proposal posts ANY balanced draft by id when a person
 * approves it — the same act as the journal page's Post, so it is gated the
 * same way. Under enforcement a draft the gate does not clear answers 409 with
 * the reason, and NOTHING is written: the journal stays an unmarked draft, the
 * proposal stays 'proposed' (retryable), no audit row. Approved, it posts and
 * is marked; with enforcement off it posts as before, unmarked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import closeRunDecide from '../../pages/api/accounting/close-run/decide';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import {
  cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, plantJournal, type JournalCompany,
} from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = journalRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

/** An open close run over the journal's period, proposing to post `journalId`. */
async function proposal(f: JournalCompany, journalId: string): Promise<{ runId: string; proposalId: string }> {
  const { rows: [je] } = await pool.query('SELECT fiscal_period_id FROM gl_journal_entries WHERE id = $1', [journalId]);
  const { rows: [run] } = await pool.query(
    `INSERT INTO close_runs(company_id,fiscal_period_id,period_label,created_by) VALUES($1,$2,'R035 2026',$3) RETURNING id`,
    [f.c, je.fiscal_period_id, u.a]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO close_run_proposals(company_id,close_run_id,kind,action_type,title,reasoning,target_entity_type,target_entity_id)
     VALUES($1,$2,'post_draft_journal','auto_post','Post JE','balanced draft','gl_journal_entry',$3) RETURNING id`,
    [f.c, run.id, journalId]);
  return { runId: run.id, proposalId: p.id };
}
const approve = (c: string, ids: { runId: string; proposalId: string }) => callRoute(closeRunDecide, tokens[u.a]!, c, 'POST',
  { ...ids, decision: 'approve' }, '/api/accounting/close-run/decide');
const proposalStatus = async (id: string) => (await pool.query('SELECT status FROM close_run_proposals WHERE id = $1', [id])).rows[0].status;
const audits = async (c: string, journalId: string) => Number((await pool.query(
  "SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND entity_id = $2 AND action = 'post'", [c, journalId])).rows[0].n);

describe("the close-run 'post_draft_journal' approval", () => {
  it('answers 409 with the reason under enforcement and writes nothing; approved, it posts and is marked', async () => {
    const f = await fixture();
    const id = await plantJournal(pool, f, u.a);
    const ids = await proposal(f, id);
    const refused = await approve(f.c, ids);
    expect(refused.state.statusCode).toBe(409);
    expect(reasonOf(refused)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(refused)).toMatch(/^Manual journal JE-\S+ needs owner approval before it can be posted/);
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', marker: null, posted_debit: 0 });
    expect(await proposalStatus(ids.proposalId)).toBe('proposed');
    expect(await audits(f.c, id)).toBe(0);

    await r.approvedBy(pool, u.a, u.b, f.c, id);
    const res = await approve(f.c, ids);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
    expect(await proposalStatus(ids.proposalId)).toBe('posted');
  });

  it('enforcement off: posts as before, unmarked', async () => {
    const f = await fixture({ enforced: false });
    const id = await plantJournal(pool, f, u.a);
    const ids = await proposal(f, id);
    expect((await approve(f.c, ids)).state.statusCode).toBe(200);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: null });
  });
});
