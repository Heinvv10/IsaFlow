/**
 * selectSweepLineIds against a real schema (decision 2, categorizeSweepScope.ts): a sweep takes only
 * imported lines with no suggestion and no decision-log row, dated or imported in the last 30 days, on the
 * one bank account, newest first, at most maxLines. Runs as app_user under RLS, as the route does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asUser, pool, seedCompany, seedLine, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import { selectSweepLineIds } from '../../src/modules/accounting/services/core/smartCategorizationService';

assertDisposable();

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
let C: Co;
let other: Co;
let user = '';
const L: Record<string, string> = {};

beforeAll(async () => {
  C = await seedCompany('sweep scope C');
  other = await seedCompany('sweep scope other');
  user = await seedUser([C.id, other.id]);
  L.recent = await seedLine(C, { date: daysAgo(1) });
  L.recent2 = await seedLine(C, { date: daysAgo(3) });
  L.edge = await seedLine(C, { date: daysAgo(29) });
  L.old = await seedLine(C, { date: daysAgo(120), createdAt: new Date(Date.now() - 120 * 86_400_000).toISOString() });
  L.oldButJustImported = await seedLine(C, { date: daysAgo(120) }); // created_at now(): a back-loaded statement
  L.allocated = await seedLine(C, { date: daysAgo(2), status: 'allocated' });
  L.suggestedAccount = await seedLine(C, { date: daysAgo(2) });
  L.suggestedCategory = await seedLine(C, { date: daysAgo(2) });
  L.inLog = await seedLine(C, { date: daysAgo(2) });
  L.otherCompany = await seedLine(other, { date: daysAgo(1) });
  await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2 WHERE id = $1', [L.suggestedAccount, C.expense]);
  await pool.query("UPDATE bank_transactions SET suggested_category = 'Fuel' WHERE id = $1", [L.suggestedCategory]);
  // A suggestion a person already rejected: the line's suggested_* were cleared, the log keeps the row.
  await pool.query(
    `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id,
       outcome, decided_at, decided_by)
     VALUES ($1, $2, 'pattern', $3, 'rejected', now(), $4)`, [C.id, L.inLog, C.expense, user]);
});

afterAll(async () => {
  await pool.query('DELETE FROM categorization_decisions WHERE company_id = ANY($1::uuid[])', [[C.id, other.id]]);
  await teardownCompanies([C.id, other.id], [user]);
  await pool.end();
});

describe('selectSweepLineIds', () => {
  it('recent uncoded lines only, newest first; old, coded, suggested and logged lines are skipped', async () => {
    const ids = await asUser(user, C.id, () => selectSweepLineIds(C.id, C.bank, { recentDays: 30, maxLines: 200 }));
    expect(ids.slice(0, 3)).toEqual([L.recent, L.recent2, L.edge]);
    expect(new Set(ids)).toEqual(new Set([L.recent, L.recent2, L.edge, L.oldButJustImported]));
  });

  it('the batch cap holds, keeping the newest', async () => {
    const ids = await asUser(user, C.id, () => selectSweepLineIds(C.id, C.bank, { recentDays: 30, maxLines: 2 }));
    expect(ids).toEqual([L.recent, L.recent2]);
  });

  it('a wider window takes the old line too', async () => {
    const ids = await asUser(user, C.id, () => selectSweepLineIds(C.id, C.bank, { recentDays: 365, maxLines: 200 }));
    expect(ids).toContain(L.old);
  });

  it('never another company\'s lines, even named by its bank account', async () => {
    const ids = await asUser(user, C.id, () => selectSweepLineIds(C.id, other.bank, { recentDays: 30, maxLines: 200 }));
    expect(ids).toEqual([]);
  });
});
