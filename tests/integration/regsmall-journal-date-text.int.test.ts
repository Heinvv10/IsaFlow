/**
 * NUMRACE register (d): POST /api/accounting/journal-entries with an entryDate
 * Postgres cannot cast answered 400 with the driver's own text
 * ('invalid input syntax for type date: "garbage"'). It now answers a
 * caller-safe 400 that names the field, with nothing written, and a refusal the
 * service raised itself (an unbalanced journal) keeps its own wording.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { inTx } from './helpers/l1FifoFixture';
import journalEntries from '../../pages/api/accounting/journal-entries';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
let c: DateFixture;
let token = '';

const lines = (credit = 10) => [
  { glAccountId: c.expense, debit: 10, credit: 0, description: 'RSJD' },
  { glAccountId: c.fx.bankAccountId, debit: 0, credit, description: 'RSJD' },
];
const journals = async (tag: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID AND description = ${tag}`) as { n: number }[])[0]!.n);
// Driver wording for a failed cast, and the SQLSTATE classes it would carry.
const DRIVER_TEXT = /invalid input syntax|type date|out of range|22007|22008|"garbage"/i;

describeIfDb('journal-entries POST: an uncastable entryDate answers caller-safe text', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('REGSMALL-JD', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'regsmall-jd');
  }, 60000);

  afterAll(async () => {
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  it.each(['garbage', '2026-02-30', '2026-13-01'])("entryDate '%s': 400 naming the field, no driver text, nothing written",
    async (entryDate) => {
      const tag = `RSJD ${entryDate}`;
      const out = await callRoute(c.fx, token, journalEntries, { entryDate, description: tag, lines: lines() });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).not.toMatch(DRIVER_TEXT);
      expect(JSON.stringify(out.body)).toMatch(/entryDate/);
      expect(await journals(tag)).toBe(0);
    }, 60000);

  it('a refusal the service raised itself keeps its own wording (unbalanced lines)', async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '2026-06-01', description: 'RSJD unbalanced', lines: lines(7),
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/balance/i);
    expect(await journals('RSJD unbalanced')).toBe(0);
  }, 60000);

  it('a valid date still creates the draft', async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '2026-06-01', description: 'RSJD ok', lines: lines(),
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await journals('RSJD ok')).toBe(1);
  }, 60000);

  // brk-nrfd LOW-2: a value the code cannot tie to a field gets neutral wording, never "check entryDate".
  it('a malformed account id: 400, no driver text, no entryDate blame, nothing written', async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '2026-06-01', description: 'RSJD bad account',
      lines: [{ glAccountId: 'not-a-uuid', debit: 10, credit: 0 }, { glAccountId: c.fx.bankAccountId, debit: 0, credit: 10 }],
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).not.toMatch(DRIVER_TEXT);
    expect(JSON.stringify(out.body)).not.toMatch(/entryDate/);
    expect(await journals('RSJD bad account')).toBe(0);
  }, 60000);

  // brk-nrfd HIGH (pre-existing) and LOW-1: NaN amounts passed validation, were stored and posted.
  it("debit/credit 'NaN': 400 from the line rules, nothing written", async () => {
    const out = await callRoute(c.fx, token, journalEntries, {
      entryDate: '2026-06-01', description: 'RSJD nan',
      lines: [{ glAccountId: c.expense, debit: 'NaN', credit: 'NaN' }, { glAccountId: c.fx.bankAccountId, debit: 'NaN', credit: 'NaN' }],
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/must be numbers/);
    expect(await journals('RSJD nan')).toBe(0);
  }, 60000);

  it('a draft already holding NaN amounts cannot be posted', async () => {
    const id = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, source, created_by)
      VALUES (${c.fx.companyId}::UUID, '2026-06-02', 'RSJD nan draft', 'draft', 'manual', ${c.fx.userId}::UUID) RETURNING id`) as { id: string }[])[0]!.id);
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES
      (${c.fx.companyId}::UUID, ${id}::UUID, ${c.expense}::UUID, 'NaN', 0),
      (${c.fx.companyId}::UUID, ${id}::UUID, ${c.fx.bankAccountId}::UUID, 0, 'NaN')`;
    const err = await inTx(c.fx, () => postJournalEntry(c.fx.companyId, id, c.fx.userId)).then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/must be numbers/);
    const status = ((await sql`SELECT status FROM gl_journal_entries WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status;
    expect(status).toBe('draft');
  }, 60000);
});
