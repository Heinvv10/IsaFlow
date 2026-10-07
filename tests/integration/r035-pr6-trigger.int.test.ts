/**
 * R-035 PR6: the manual-journal backstop (migration 869,
 * trg_manual_journal_approval_gate_ins / _upd).
 *
 * gl_journal_entries carries every system posting, so the trigger judges only
 * a MARKED journal — one a gated path created or posted while enforcement was
 * on. For those:
 *  - entering 'posted' by raw SQL (an UPDATE from draft or reversed, or an
 *    INSERT) without a cleared approval raises R035_APPROVAL_REQUIRED, as
 *    app_user and as the table owner; with a cleared approval, below the rule,
 *    or with enforcement off it passes; a manager approval under an owner rule
 *    and another company's approval clear nothing;
 *  - draft -> reversed (no ledger effect) passes;
 *  - the marker cannot be removed or changed.
 * An UNMARKED journal — a system posting — posts under enforcement as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
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

async function gated(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, u.b);
  return f;
}

const flip = (id: string, status = 'posted') => pool.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [id, status]);
const flipAsApp = (f: JournalCompany, id: string) => asAppUser(pool, u.a, f.c,
  (client) => client.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [id]));

describe('a marked journal entering posted', () => {
  it('is refused by raw SQL as app_user and as the owner, without an approval', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a, { marked: true });
    await expect(flipAsApp(f, id)).rejects.toThrow(/R035_APPROVAL_REQUIRED: manual journal/);
    await expect(flip(id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect(await journalState(pool, id)).toMatchObject({ status: 'draft', posted_debit: 0 });
  });

  it('is refused when INSERTed as posted', async () => {
    const f = await gated();
    await expect(pool.query(
      `INSERT INTO gl_journal_entries(company_id,entry_date,description,source,status,created_by,approval_document_type)
       VALUES($1,DATE '2026-09-01','raw','manual','posted',$2,'manual_journal')`, [f.c, u.a],
    )).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('passes once approved for its current content, and goes stale when the content moves', async () => {
    const f = await gated();
    const stale = await plantJournal(pool, f, u.a, { marked: true });
    await r.approvedBy(pool, u.a, u.b, f.c, stale);
    await pool.query("UPDATE gl_journal_lines SET description = 'moved' WHERE journal_entry_id = $1 AND debit > 0", [stale]);
    await expect(flip(stale)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);

    const id = await plantJournal(pool, f, u.a, { marked: true });
    await r.approvedBy(pool, u.a, u.b, f.c, id);
    await flipAsApp(f, id);
    expect(await journalState(pool, id)).toMatchObject({ status: 'posted', posted_debit: 1500 });
  });

  it('a manager approval does not clear once an owner rule governs (the ratchet)', async () => {
    const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
    const managerRule = await plantRule(pool, f.c, 'manager', { documentType: 'manual_journal' });
    await enforceJournals(pool, f.c, u.b);
    const id = await plantJournal(pool, f, u.a, { marked: true });
    await r.approvedBy(pool, u.a, u.m, f.c, id);
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [managerRule]);
    await journalRule(plantRule, pool, f.c, { value: 0 });
    await expect(flip(id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it("another company's approval, or one decided before enforcement, clears nothing", async () => {
    const f = await gated();
    const g = await journalCompany(pool, [[u.a, 'admin']], companies);
    const id = await plantJournal(pool, f, u.a, { marked: true });
    await pool.query(
      `INSERT INTO approval_requests(company_id,document_type,document_id,amount,requested_by,status,decided_by,decided_at,required_role,document_digest)
       VALUES($1,'manual_journal',$2,1500,$3,'approved',$4,now(),'owner',approval_document_digest($5,'manual_journal',$2))`,
      [g.c, id, u.a, u.b, f.c]);
    await expect(flip(id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);

    const early = await gated({ enforced: false });
    const late = await plantJournal(pool, early, u.a, { marked: true });
    await r.approvedBy(pool, u.a, u.b, early.c, late);
    await enforceJournals(pool, early.c, u.b, new Date(Date.now() + 1000).toISOString());
    await expect(flip(late)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('passes below the rule, and with enforcement off', async () => {
    const f = await gated();
    const small = await plantJournal(pool, f, u.a, { marked: true, amount: 900 });
    await flip(small);
    const off = await gated({ enforced: false });
    const id = await plantJournal(pool, off, u.a, { marked: true });
    await flip(id);
    expect((await journalState(pool, small)).status).toBe('posted');
    expect((await journalState(pool, id)).status).toBe('posted');
  });

  it('draft -> reversed passes; reversed -> posted is judged like any entry into posted', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a, { marked: true });
    await flip(id, 'reversed');
    await expect(flip(id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });
});

describe('the marker', () => {
  it('cannot be removed or changed, by app_user or the owner', async () => {
    const f = await gated();
    const id = await plantJournal(pool, f, u.a, { marked: true });
    await expect(pool.query('UPDATE gl_journal_entries SET approval_document_type = NULL WHERE id = $1', [id]))
      .rejects.toThrow(/R035_APPROVAL_MARKER/);
    await expect(asAppUser(pool, u.a, f.c, (client) => client.query(
      "UPDATE gl_journal_entries SET approval_document_type = NULL, status = 'posted' WHERE id = $1", [id])))
      .rejects.toThrow(/R035_APPROVAL_MARKER/);
    await expect(pool.query("UPDATE gl_journal_entries SET approval_document_type = 'other' WHERE id = $1", [id]))
      .rejects.toThrow(/approval_document_type_check|R035_APPROVAL_MARKER/);
    expect((await journalState(pool, id)).marker).toBe('manual_journal');
  });
});

describe('an unmarked journal', () => {
  it('posts under enforcement as it always has — the system postings are not gated', async () => {
    const f = await gated();
    for (const source of ['auto_invoice', 'auto_payroll', 'auto_depreciation', 'manual']) {
      const id = await plantJournal(pool, f, u.a, { source });
      await flipAsApp(f, id);
      expect((await journalState(pool, id)).status, source).toBe('posted');
    }
  });
});
