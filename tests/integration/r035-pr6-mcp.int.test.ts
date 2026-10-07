/**
 * R-035 PR6, decision Q6: an agent may neither raise nor decide an approval,
 * so the MCP journal tools refuse a gated journal — from a READ, before
 * anything is written.
 *
 *  - post_journal answers a tool error carrying the gate's reason; the draft is
 *    untouched (no post, no marker), no request is raised, and the idempotency
 *    key stays free for the call that succeeds once a person has had it
 *    approved — which posts and marks it.
 *  - create_draft_journal stays ungated: it writes a draft only.
 *  - post_reclassification_batch creates and posts in one call with no draft
 *    surviving, so under enforcement it is refused up front when any journal it
 *    would post matches a rule — the dry run with the same refusal — and posts
 *    (marked) when none does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createDraftJournalTool, postJournalTool } from '../../src/lib/mcp/tools/writeJournals';
import { postReclassificationBatchTool } from '../../src/lib/mcp/tools/writeReclassification';
import { setOpeningBalanceTool } from '../../src/lib/mcp/tools/writeOpeningBalance';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
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

async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId, companyId, claims: { sub: userId } } as never, fn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const registry = new McpRegistry();
for (const tool of [postJournalTool, createDraftJournalTool, postReclassificationBatchTool, setOpeningBalanceTool]) registry.register(tool);
const mcp = (c: string, name: string, args: Record<string, unknown>) => asUser(u.a, c, () => registry.call(name, args,
  { userId: u.a, companyId: c, scopes: ['write:journals', 'write:post'], tokenJti: 'r035-pr6', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;
const requestsFor = async (id: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [id])).rows[0].n);

/** A (admin) runs the agent; B (owner) approves. An owner rule over R1 000, enforced unless asked otherwise. */
async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

describe('post_journal', () => {
  it('refuses a gated draft before writing, and leaves its idempotency key free', async () => {
    const f = await fixture();
    const id = await plantJournal(pool, f, u.a);
    const key = `r035-pr6-${id}`;
    const refused = await mcp(f.c, 'post_journal', { journal_id: id, idempotency_key: key });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Manual journal JE-\S+ needs owner approval before it can be posted/);
    expect(text(refused)).toMatch(/cannot raise or decide approvals/);
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', marker: null, posted_debit: 0 });
    expect(await requestsFor(id)).toBe(0);

    await r.approvedBy(pool, u.a, u.b, f.c, id);
    const posted = await mcp(f.c, 'post_journal', { journal_id: id, idempotency_key: key });
    expect(posted.isError, text(posted)).toBeFalsy();
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });

  it('enforcement off: posts as before, unmarked', async () => {
    const f = await fixture({ enforced: false });
    const id = await plantJournal(pool, f, u.a);
    const res = await mcp(f.c, 'post_journal', { journal_id: id, idempotency_key: `r035-pr6-off-${id}` });
    expect(res.isError, text(res)).toBeFalsy();
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: null });
  });

  it('a not-found journal is still reported as before', async () => {
    const f = await fixture();
    const res = await mcp(f.c, 'post_journal', { journal_id: crypto.randomUUID(), idempotency_key: `r035-pr6-nf-${f.c}` });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/i);
  });
});

describe('create_draft_journal', () => {
  // Round 3 (blind LOW): marked at create under enforcement, so the backstop
  // covers a person's draft too; still a draft only, and no request.
  it('stays ungated under enforcement: a draft, marked, no request', async () => {
    const f = await fixture();
    const res = await mcp(f.c, 'create_draft_journal', {
      date: '2026-09-01', memo: 'agent draft', idempotency_key: `r035-pr6-draft-${f.c}`,
      lines: [{ account_id: f.expA, debit: 5000 }, { account_id: f.bank, credit: 5000 }],
    });
    expect(res.isError, text(res)).toBeFalsy();
    const { id } = JSON.parse(text(res)) as { id: string };
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', marker: 'manual_journal' });
    expect(await requestsFor(id)).toBe(0);
  });
});

describe('post_reclassification_batch', () => {
  /** Posted history: R1 500 (or `amount`) on expA, which the batch moves to expB. */
  async function history(f: JournalCompany, amount = 1500): Promise<void> {
    const id = await plantJournal(pool, f, u.a, { amount });
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
  }
  const batches = async (c: string) => Number((await pool.query(
    'SELECT count(*)::INT AS n FROM reclassification_batches WHERE company_id = $1', [c])).rows[0].n);
  const journals = async (c: string) => Number((await pool.query(
    "SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND source = 'auto_adjustment'", [c])).rows[0].n);

  it('is refused up front — live and dry run alike — when a journal it would post is gated', async () => {
    const f = await fixture();
    await history(f);
    const args = { source_account_id: f.expA, target_account_id: f.expB };
    const dry = await mcp(f.c, 'post_reclassification_batch', { ...args, dry_run: true, idempotency_key: `r035-pr6-rd-${f.c}` });
    const live = await mcp(f.c, 'post_reclassification_batch', { ...args, idempotency_key: `r035-pr6-rl-${f.c}` });
    for (const res of [dry, live]) {
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/Manual journals are enforced: a journal of R1500\.00 needs owner approval/);
    }
    expect(await journals(f.c)).toBe(0);
    expect(await batches(f.c)).toBe(0);
  });

  it('posts, marked, when no journal it would post is gated', async () => {
    const f = await fixture();
    await history(f, 900);
    const res = await mcp(f.c, 'post_reclassification_batch', {
      source_account_id: f.expA, target_account_id: f.expB, idempotency_key: `r035-pr6-rs-${f.c}` });
    expect(res.isError, text(res)).toBeFalsy();
    const { journal_entry_ids: ids } = JSON.parse(text(res)) as { journal_entry_ids: string[] };
    expect(ids).toHaveLength(1);
    expect(await journalState(pool, ids[0]!)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });
});

// Round 4 (Hein, 2026-10-07, adversarial REPRO 3; supersedes round 3's
// contra-only rule): an agent could relabel any asset 'bank' and post it
// against Opening Balance Equity. Under enforcement the tool is refused
// ENTIRELY, from a read, nothing written: a person enters opening balances.
describe('set_opening_balance', () => {
  const ob = (f: JournalCompany, contra?: string) => mcp(f.c, 'set_opening_balance', {
    bank_account_id: f.bank, as_at: '2026-01-01', amount: 2500, idempotency_key: `r035-pr6-ob-${f.c}-${contra ?? 'obe'}`,
    ...(contra ? { contra_account_id: contra } : {}),
  });
  const written = async (c: string) => (await pool.query(
    `SELECT (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals,
            (SELECT count(*)::INT FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'opening_balance_equity') AS obe`,
    [c])).rows[0];

  it('under enforcement is refused entirely — default contra or not — from a read, nothing written', async () => {
    const f = await fixture();
    for (const contra of [undefined, f.expA]) {
      const refused = await ob(f, contra);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/a person enters opening balances in IsaFlow/);
    }
    expect(await written(f.c)).toEqual({ journals: 0, obe: 0 });
  });

  it('enforcement off: posts as before, any contra', async () => {
    const f = await fixture({ enforced: false });
    const res = await ob(f, f.expA);
    expect(res.isError, text(res)).toBeFalsy();
  });
});
