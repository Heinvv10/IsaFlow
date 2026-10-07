/**
 * R-035 PR6: what a manual-journal approval vouches for (migration 869).
 *
 *  - Every hashed header column (date, description, reference, project, cost
 *    centre, intercompany flag and counterparty) and every hashed line column
 *    (account, debit, credit, narrative, VAT code and the five dimensions)
 *    moves approval_document_digest(…, 'manual_journal', …); the bookkeeping
 *    it deliberately leaves out (status, number, source, posting, evidence,
 *    actor stamps, the marker, content_authors) does not.
 *  - Line order and re-insertion behave as for bills (708): the same lines in
 *    another order, or deleted and re-inserted, digest the same; 100 and
 *    100.00 are one value.
 *  - Another company's id, and a journal of another company, digest to NULL.
 *  - The gate amount is the larger side of the journal, so a draft whose
 *    sides disagree is never read at its smaller one; the authors are the
 *    creator plus content_authors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr6, journalCompany, journalDigest, plantJournal, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
let f: JournalCompany;
let other: JournalCompany;

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
  f = await journalCompany(pool, [[u.a, 'admin']], companies);
  other = await journalCompany(pool, [[u.b, 'admin']], companies);
});
afterAll(() => cleanupPr6(pool, companies, Object.values(u)));

const header = (id: string, set: string, value: unknown) =>
  pool.query(`UPDATE gl_journal_entries SET ${set} = $2 WHERE id = $1`, [id, value]);
const lines = (id: string, set: string, value: unknown) =>
  pool.query(`UPDATE gl_journal_lines SET ${set} = $2 WHERE journal_entry_id = $1 AND debit > 0`, [id, value]);

/** Apply `change`, then expect the digest to have moved (or not). */
async function moves(id: string, change: () => Promise<unknown>, expected: boolean) {
  const before = await journalDigest(pool, f.c, id);
  expect(before).toMatch(/^[0-9a-f]{64}$/);
  await change();
  const after = await journalDigest(pool, f.c, id);
  if (expected) expect(after).not.toBe(before);
  else expect(after).toBe(before);
}

describe('the manual_journal digest', () => {
  const headerCases: [string, () => unknown][] = [
    ['entry_date', () => '2026-09-02'], ['description', () => 'changed'], ['reference', () => 'REF-2'],
    ['project_id', () => crypto.randomUUID()], ['cost_center_id', () => crypto.randomUUID()],
    ['is_intercompany', () => true], ['intercompany_company_id', () => other.c],
  ];
  for (const [column, value] of headerCases) {
    it(`moves with the header's ${column}`, async () => {
      const id = await plantJournal(pool, f, u.a);
      await moves(id, () => header(id, column, value()), true);
    });
  }

  const lineCases: [string, () => unknown][] = [
    ['gl_account_id', () => f.expB], ['debit', () => 1500.01], ['description', () => 'changed'],
    ['vat_type', () => 'standard'], ['cc1_id', () => crypto.randomUUID()], ['cc2_id', () => crypto.randomUUID()],
    ['bu_id', () => crypto.randomUUID()], ['project_id', () => crypto.randomUUID()],
    ['cost_center_id', () => crypto.randomUUID()],
  ];
  for (const [column, value] of lineCases) {
    it(`moves with a line's ${column}`, async () => {
      const id = await plantJournal(pool, f, u.a);
      await moves(id, () => lines(id, column, value()), true);
    });
  }

  it("moves with a line's credit", async () => {
    const id = await plantJournal(pool, f, u.a);
    await moves(id, () => pool.query('UPDATE gl_journal_lines SET credit = 1499 WHERE journal_entry_id = $1 AND credit > 0', [id]), true);
  });

  it('moves when a line is added', async () => {
    const id = await plantJournal(pool, f, u.a);
    await moves(id, () => pool.query(
      `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,0,0)`,
      [f.c, id, f.expB]), true);
  });

  const excluded: [string, () => unknown][] = [
    ['status', () => 'reversed'], ['entry_number', () => 'JE-OTHER'], ['source', () => 'auto_recurring'],
    ['posted_at', () => new Date()], ['posting_agent', () => 'mcp:test'], ['needs_evidence', () => true],
    ['external_ref', () => 'EXT-1'], ['approval_document_type', () => 'manual_journal'],
    ['content_authors', () => [crypto.randomUUID()]],
  ];
  for (const [column, value] of excluded) {
    it(`does not move with the header's ${column}`, async () => {
      const id = await plantJournal(pool, f, u.a);
      await moves(id, () => header(id, column, value()), false);
    });
  }

  it('is the same for the same lines re-inserted (new ids, new created_at) and at another scale', async () => {
    const id = await plantJournal(pool, f, u.a);
    await moves(id, async () => {
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [id]);
      await pool.query(
        `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
         VALUES($1,$2,$4,0,1500.00,'cr'),($1,$2,$3,1500.000,0,'dr')`, [f.c, id, f.expA, f.bank]);
    }, false);
  });

  it("is NULL under another company's id, and for an unknown journal", async () => {
    const id = await plantJournal(pool, f, u.a);
    expect(await journalDigest(pool, other.c, id)).toBeNull();
    expect(await journalDigest(pool, f.c, crypto.randomUUID())).toBeNull();
  });
});

describe('the gate amount and the authors', () => {
  const amount = async (id: string, company = f.c) => Number((await pool.query(
    'SELECT approval_manual_journal_gate_amount($1,$2) AS a', [company, id])).rows[0].a);

  it('is the debit total, and nothing under another company', async () => {
    const id = await plantJournal(pool, f, u.a, { amount: 2500 });
    expect(await amount(id)).toBe(2500);
    expect(await amount(id, other.c)).toBe(0);
  });

  it('a draft whose sides disagree is read at its larger side', async () => {
    const id = await plantJournal(pool, f, u.a, { amount: 1 });
    await pool.query(
      `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$2,$3,0,1000000)`, [f.c, id, f.expB]);
    expect(await amount(id)).toBe(1000001);
  });

  it('the authors are the creator plus content_authors, de-duplicated, company-scoped', async () => {
    const id = await plantJournal(pool, f, u.a);
    const authors = async (company = f.c) => (await pool.query(
      "SELECT approval_document_authors($1,'manual_journal',$2)::TEXT[] AS a", [company, id])).rows[0].a as string[] | null;
    expect(await authors()).toEqual([u.a]);
    await pool.query('UPDATE gl_journal_entries SET content_authors = ARRAY[$2::UUID, $3::UUID] WHERE id = $1', [id, u.b, u.a]);
    expect(await authors()).toEqual([u.b, u.a]);
    expect(await authors(other.c)).toBeNull();
  });
});
