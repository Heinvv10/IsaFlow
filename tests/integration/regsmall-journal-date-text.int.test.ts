/**
 * NUMRACE register (d): POST /api/accounting/journal-entries with an entryDate
 * Postgres cannot cast answered 400 with the driver's own text
 * ('invalid input syntax for type date: "garbage"'). It now answers a
 * caller-safe 400 that names the field, with nothing written, and a refusal the
 * service raised itself (an unbalanced journal) keeps its own wording.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
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
      process.stdout.write(`RSJD ${entryDate} ${JSON.stringify(out)}\n`);
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
});
