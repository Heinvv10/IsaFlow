/**
 * R-035 PR6: the manual-journal gate on the UI post (journal-entries-action).
 *
 *  - Under enforcement a draft an active rule matches answers 409 with the
 *    reason, and NOTHING is written: still a draft, unmarked, no balance moved.
 *    The route gates ANY draft a person posts, whatever created it (a draft
 *    left by a recurring run or a receipt is posted here too).
 *  - Raise (A) → approve (B) → post (A) answers 200, and the posted journal
 *    carries the 869 marker.
 *  - The approval checks, as for every type: the rank ratchet, enforcement off
 *    (behaviour and writes unchanged — no marker), tenant isolation, a NULL
 *    digest, and an approval decided before enforcement was switched on.
 *  - The detail GET carries the derived approval state for a draft, null once
 *    posted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  cleanupPr6, enforceJournals, journalCompany, journalRoutes, journalRule, journalState, plantJournal, type JournalCompany,
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

/** A (admin) composes and posts; B and C (owners) approve; M is a manager. Owner rule over R1 000, enforced. */
async function gated(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.m, 'manager']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

const approvalOf = (res: { state: { body: unknown } }) =>
  dataOf<{ approval: { state: string; requestId: string | null } | null }>(res).approval;

describe('the UI post under enforcement', () => {
  it('answers 409 and writes nothing: still a draft, unmarked, no balance moved', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    const res = await r.post(u.a, f.c, id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(messageOf(res)).toMatch(/^Manual journal JE-\S+ needs owner approval before it can be posted \(rule: Journals sign\)\.$/);
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', marker: null, posted_debit: 0 });
  });

  it('raise → approve → post answers 200 and marks the posted journal', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    const res = await r.post(u.a, f.c, id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal', posted_debit: 1500 });
  });

  it('a pending request answers APPROVAL_PENDING', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    const raised = await r.raise(u.a, f.c, id);
    const res = await r.post(u.a, f.c, id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_PENDING');
    expect((res.state.body as { error: { details: { requestId: string } } }).error.details.requestId)
      .toBe(dataOf<{ id: string }>(raised).id);
  });

  it('gates any draft a person posts, whatever created it', async () => {
    const f = await gated();
    for (const source of ['auto_recurring', 'auto_expense_receipt', 'auto_gl_import']) {
      const id = await plantJournal(pool, f, u.a, { source });
      expect((await r.post(u.a, f.c, id)).state.statusCode, source).toBe(409);
    }
  });

  it('a journal under the rule threshold posts, and is marked', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a, { amount: 900 });
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: 'manual_journal' });
  });

  it('a journal that is not a draft keeps the posting service\'s own refusal (not a 409)', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a, { amount: 900 });
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    const again = await r.post(u.a, f.c, id);
    expect(again.state.statusCode).toBe(400);
    expect(messageOf(again)).toMatch(/Cannot post entry with status: posted/);
  });
});

describe('the approval checks', () => {
  it('the rank ratchet: a manager approval does not clear once an owner rule governs', async () => {
    const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
    const managerRule = await plantRule(pool, f.c, 'manager', { documentType: 'manual_journal' });
    await enforceJournals(pool, f.c, u.b);
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.m, f.c, id);
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [managerRule]);
    await journalRule(plantRule, pool, f.c, { value: 0 });
    const res = await r.post(u.a, f.c, id);
    expect(res.state.statusCode).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  });

  it('enforcement off: posts as before and writes no 869 column', async () => {
    const f = await gated({ enforced: false });
    const id = await plantJournal(pool, f, u.a);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', marker: null, authors: [] });
  });

  it("tenant isolation: another company's approval or enforcement does not count", async () => {
    const f = await gated();
    const g = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    const id = await plantJournal(pool, f, u.a);
    const rule = (await pool.query("SELECT id FROM approval_rules WHERE company_id = $1 AND document_type = 'manual_journal'", [f.c])).rows[0].id;
    await pool.query(
      `INSERT INTO approval_requests(company_id,rule_id,document_type,document_id,amount,requested_by,status,decided_by,decided_at,required_role,document_digest)
       VALUES($1,$2,'manual_journal',$3,1500,$4,'approved',$5,now(),'owner',approval_document_digest($6,'manual_journal',$3))`,
      [g.c, rule, id, u.a, u.b, f.c]);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(409);

    // B's enforcement does not enforce on A's company.
    const open = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await journalRule(plantRule, pool, open.c);
    await enforceJournals(pool, g.c, u.b);
    const free = await plantJournal(pool, open, u.a);
    expect((await r.post(u.a, open.c, free)).state.statusCode).toBe(200);
  });

  it('an approved request with a NULL digest clears nothing', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    const requestId = await r.approvedBy(pool, u.a, u.b, f.c, id);
    await pool.query('UPDATE approval_requests SET document_digest = NULL WHERE id = $1', [requestId]);
    const res = await r.post(u.a, f.c, id);
    expect(res.state.statusCode).toBe(409);
    // Approved at rank, for no content this journal has: the gate's STALE.
    expect(reasonOf(res)).toBe('APPROVAL_STALE');
    expect((await journalState(pool, id)).status).toBe('draft');
  });

  it('an approval decided before enforcement was switched on clears nothing', async () => {
    const f = await gated({ enforced: false });
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    await enforceJournals(pool, f.c, u.b, new Date(Date.now() + 1000).toISOString());
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(409);
  });

  it('a content change after approval makes it STALE; putting it back clears it (Q9)', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    await pool.query("UPDATE gl_journal_entries SET description = 'moved' WHERE id = $1", [id]);
    const stale = await r.post(u.a, f.c, id);
    expect(stale.state.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe('APPROVAL_STALE');
    await pool.query("UPDATE gl_journal_entries SET description = 'R035 journal' WHERE id = $1", [id]);
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
  });
});

describe('the detail GET', () => {
  it('carries the derived approval state while a draft, and null once posted', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a);
    expect(approvalOf(await r.get(u.a, f.c, id))).toMatchObject({ state: 'required', requiredRole: 'owner', ruleName: 'Journals sign' });
    const requestId = await r.approvedBy(pool, u.a, u.b, f.c, id);
    expect(approvalOf(await r.get(u.a, f.c, id))).toMatchObject({ state: 'approved', requestId });
    expect((await r.post(u.a, f.c, id)).state.statusCode).toBe(200);
    expect(approvalOf(await r.get(u.a, f.c, id))).toBeNull();
  });

  it('says not_required when enforcement is off', async () => {
    const f = await gated({ enforced: false });
    const id = await plantJournal(pool, f, u.a);
    expect(approvalOf(await r.get(u.a, f.c, id))).toMatchObject({ state: 'not_required', enforced: false });
  });
});
