/**
 * R-035 PR6: who may approve a manual journal, and the request rules.
 *
 *  - The creator may not approve it; another owner may (refusal names the journal).
 *  - Q2: a sole owner may approve their own request under enforcement.
 *  - The account merge — the one path that edits a draft journal's content —
 *    makes the merging user an author (only under enforcement) and stales an
 *    approval (Q10).
 *  - The insert guard binds manual_journal: app_user cannot insert an approved
 *    request, nor one raised for someone else.
 *  - The legacy `journal_entry` type: a new rule of it is refused, naming
 *    manual_journal, and the enforcement GET counts the active ones (the switch
 *    warns); manual_journal itself may be switched on, and the preview counts
 *    the drafts it would hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { mergeAccounts } from '../../src/modules/accounting/services/gl/accountMergeService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { asAppUser } from './r035-pr4.helpers';
import {
  cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, plantJournal, type JournalCompany,
} from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = journalRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

async function gated(members: [string, string][], opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, members, companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, members.find(([, role]) => role === 'owner')![0]);
  return f;
}

async function merge(f: JournalCompany, by: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: by, companyId: f.c, claims: { sub: by } } as never,
      () => mergeAccounts(f.c, f.expA, f.expB, by));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('the approvers', () => {
  it('the creator may not approve the journal; another owner may', async () => {
    const f = await gated([[u.a, 'owner'], [u.b, 'owner']]);
    const id = await plantJournal(pool, f, u.a);
    const requestId = dataOf<{ id: string }>(await r.raise(u.b, f.c, id)).id;
    const refused = await r.decide(pool, u.a, f.c, requestId);
    expect(refused.state.statusCode).toBe(403);
    expect(messageOf(refused)).toMatch(/you created the journal/);
    expect((await r.decide(pool, u.b, f.c, requestId)).state.statusCode).toBe(403); // the requester, with another owner left
  });

  it('Q2: a sole owner approves their own request, and the journal posts', async () => {
    const f = await gated([[u.a, 'owner'], [u.m, 'manager']]);
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.a, f.c, id);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
  });

  it('the account merge stales the approval and makes the merging user an author, enforced or not', async () => {
    const f = await gated([[u.a, 'admin'], [u.b, 'owner'], [u.m, 'owner']]);
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    await merge(f, u.m);
    expect((await journalState(pool, id)).authors).toEqual([u.m]);
    const stale = await r.post(u.a, f.c, id);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    const requestId = dataOf<{ id: string }>(await r.raise(u.a, f.c, id)).id;
    expect((await r.decide(pool, u.m, f.c, requestId)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.b, f.c, requestId)).state.statusCode).toBe(200);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);

    // Round 3 (adversarial REPRO 1b): recorded with enforcement off too — the
    // draft is gated like any other once the switch goes on.
    const off = await gated([[u.a, 'admin'], [u.b, 'owner'], [u.m, 'owner']], { enforced: false });
    const draft = await plantJournal(pool, off, u.a);
    await merge(off, u.b);
    expect((await journalState(pool, draft)).authors).toEqual([u.b]);
    await enforceJournals(pool, off.c, u.m);
    const late = dataOf<{ id: string }>(await r.raise(u.a, off.c, draft)).id;
    expect((await r.decide(pool, u.b, off.c, late)).state.statusCode).toBe(403);
  });

  it('the insert guard: app_user cannot insert an approved request, or one raised for someone else', async () => {
    const f = await gated([[u.a, 'admin'], [u.b, 'owner']]);
    const id = await plantJournal(pool, f, u.a);
    const insert = (status: string, requestedBy: string) => asAppUser(pool, u.a, f.c, (client) => client.query(
      `INSERT INTO approval_requests(company_id,document_type,document_id,amount,requested_by,status)
       VALUES($1,'manual_journal',$2,1500,$3,$4)`, [f.c, id, requestedBy, status]));
    // R-035 N1 (migration 872): app_user holds no INSERT on approval_requests.
    await expect(insert('approved', u.a)).rejects.toThrow(/permission denied for table approval_requests/);
    await expect(insert('pending', u.b)).rejects.toThrow(/permission denied for table approval_requests/);
  });
});

describe('the legacy journal_entry type and the switch', () => {
  it('refuses a new journal_entry rule, naming manual_journal', async () => {
    const f = await journalCompany(pool, [[u.a, 'owner']], companies);
    const res = await callRoute(approvalRules, tokens[u.a]!, f.c, 'POST',
      { name: 'old', documentType: 'journal_entry', conditionField: 'amount', conditionOperator: 'any', approverRole: 'owner' },
      '/api/accounting/approval-rules');
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/no longer govern any journal\. Create a manual_journal rule instead/);
  });

  it('counts active legacy rules, enables manual_journal, and previews the drafts it would hold', async () => {
    const f = await journalCompany(pool, [[u.a, 'owner']], companies);
    await plantRule(pool, f.c, 'owner', { documentType: 'journal_entry' });
    await journalRule(plantRule, pool, f.c);
    await plantJournal(pool, f, u.a);
    await plantJournal(pool, f, u.a, { amount: 900 });
    const get = () => callRoute(approvalEnforcement, tokens[u.a]!, f.c, 'GET', undefined,
      '/api/accounting/approval-enforcement', { preview: '1' });
    const before = dataOf<{ legacyJournalRules: number; enforceable: string[]; preview: Record<string, number> }>(await get());
    expect(before).toMatchObject({ legacyJournalRules: 1, preview: { manual_journal: 1 } });
    expect(before.enforceable).toContain('manual_journal');
    const on = await callRoute(approvalEnforcement, tokens[u.a]!, f.c, 'POST', { documentType: 'manual_journal', enabled: true },
      '/api/accounting/approval-enforcement');
    expect(on.state.statusCode, JSON.stringify(on.state.body)).toBe(200);
    expect((await pool.query("SELECT 1 FROM approval_enforcement WHERE company_id = $1 AND document_type = 'manual_journal'",
      [f.c])).rowCount).toBe(1);
  });
});
