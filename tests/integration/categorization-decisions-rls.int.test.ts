/**
 * Migration 903: categorization_decisions under app_user is scoped to the ACTIVE company the caller belongs
 * to (897's policy form), app_user cannot DELETE or re-home a row, and the composite FKs refuse another
 * tenant's bank line or GL account. Then codingDecisionLog's writers end to end under app_user, the way
 * withAuth runs them: pending -> accepted / recoded / rejected, auto-posted -> undone / recoded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asPool, asUser, pool, seedCompany, seedLine, seedUser, teardownCompanies, type Co } from './learning-loop.helpers';
import {
  recordAllocationDecision, recordAutoPosted, recordAutoPostUndone, recordExcluded, recordHandCorrected,
  recordSuggestionsShown,
} from '../../src/modules/accounting/services/bank/codingDecisionLog';

assertDisposable();

let A: Co;
let B: Co;
let bothUser = '';
let aOnlyUser = '';
let lineA = '';
let lineB = '';
let decA = '';
let decB = '';

const insertDecision = (c: { query: typeof pool.query } | typeof pool, companyId: string, txId: string) =>
  (c as typeof pool).query<{ id: string }>(
    `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id)
     VALUES ($1, $2, 'pattern', NULL) RETURNING id`, [companyId, txId]);

beforeAll(async () => {
  A = await seedCompany('903 RLS company A');
  B = await seedCompany('903 RLS company B');
  bothUser = await seedUser([A.id, B.id]);
  aOnlyUser = await seedUser([A.id]);
  lineA = await seedLine(A);
  lineB = await seedLine(B);
  decA = (await insertDecision(pool, A.id, lineA)).rows[0]!.id;
  decB = (await insertDecision(pool, B.id, lineB)).rows[0]!.id;
});

afterAll(async () => {
  try {
    await teardownCompanies([A.id, B.id], [bothUser, aOnlyUser]);
  } finally {
    await pool.end();
  }
});

describe('categorization_decisions: a two-company member working in A cannot reach B', () => {
  it('sees A\'s decision and not B\'s', async () => {
    const ids = await asUser(bothUser, A.id, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM categorization_decisions WHERE id = ANY($1::uuid[])', [[decA, decB]])).rows.map((r) => r.id));
    expect(ids).toEqual([decA]);
  });

  it('cannot update B\'s decision', async () => {
    const n = await asUser(bothUser, A.id, async (c) =>
      (await c.query("UPDATE categorization_decisions SET outcome = 'rejected', decided_at = now() WHERE id = $1", [decB])).rowCount);
    expect(n).toBe(0);
  });

  it('cannot insert a decision into B', async () => {
    await expect(asUser(bothUser, A.id, (c) => insertDecision(c, B.id, lineB))).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot delete even its own decision (no DELETE grant)', async () => {
    await expect(asUser(bothUser, A.id, (c) => c.query('DELETE FROM categorization_decisions WHERE id = $1', [decA])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('cannot re-home a decision (company_id is not an updatable column)', async () => {
    await expect(asUser(bothUser, A.id, (c) => c.query('UPDATE categorization_decisions SET company_id = $2 WHERE id = $1', [decA, B.id])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('switching the active company to B reaches B', async () => {
    const n = await asUser(bothUser, B.id, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM categorization_decisions WHERE id = $1', [decB])).rows[0]!.n);
    expect(n).toBe(1);
  });
});

describe('categorization_decisions: a forged company GUC is not enough', () => {
  it('a member of A only, with the GUC naming B, sees nothing of B and cannot write to it', async () => {
    const n = await asUser(aOnlyUser, B.id, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM categorization_decisions WHERE id = $1', [decB])).rows[0]!.n);
    expect(n).toBe(0);
    await expect(asUser(aOnlyUser, B.id, (c) => insertDecision(c, B.id, lineB))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('categorization_decisions: the composite FKs bind the tenant even for the pool role', () => {
  it('A\'s row cannot name B\'s bank line', async () => {
    await expect(asPool((c) => insertDecision(c, A.id, lineB))).rejects.toMatchObject({ code: '23503' });
  });
  it('A\'s row cannot name B\'s GL account', async () => {
    const fresh = await seedLine(A); // no pending row yet, so only the FK can refuse it
    await expect(asPool((c) => c.query(
      `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id)
       VALUES ($1, $2, 'rule', $3)`, [A.id, fresh, B.expense]))).rejects.toMatchObject({ code: '23503' });
    await expect(asPool((c) => c.query(
      `INSERT INTO categorization_decisions (company_id, bank_transaction_id, suggestion_source, suggested_gl_account_id)
       VALUES ($1, $2, 'rule', $3)`, [A.id, fresh, A.expense]))).resolves.toBeTruthy();
  });
  it('one pending decision per line', async () => {
    await expect(asPool((c) => insertDecision(c, A.id, lineA))).rejects.toMatchObject({ code: '23505' });
  });
});

describe('codingDecisionLog under app_user (as withAuth runs it)', () => {
  const outcomeOf = async (c: { query: typeof pool.query }, txId: string) =>
    (await (c as typeof pool).query<{ outcome: string; final_gl_account_id: string | null; decided_by: string | null; was_auto_posted: boolean }>(
      `SELECT outcome, final_gl_account_id::TEXT AS final_gl_account_id, decided_by, was_auto_posted
       FROM categorization_decisions WHERE bank_transaction_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [txId])).rows[0];

  it('a suggestion opens a pending row; allocating to it accepts it; to another account recodes it', async () => {
    const l1 = await seedLine(A);
    const l2 = await seedLine(A);
    await asUser(bothUser, A.id, async (c) => {
      await recordSuggestionsShown(A.id, [
        { txId: l1, source: 'pattern', glAccountId: A.expense, confidence: 0.9 },
        { txId: l2, source: 'llm', glAccountId: A.expense, confidence: 0.7 },
      ]);
      expect((await outcomeOf(c, l1))!.outcome).toBe('pending');
      await recordAllocationDecision(A.id, l1, bothUser, { glAccountId: A.expense, contactId: null });
      await recordAllocationDecision(A.id, l2, bothUser, { glAccountId: A.other, contactId: null });
      expect(await outcomeOf(c, l1)).toMatchObject({ outcome: 'accepted', final_gl_account_id: A.expense, decided_by: bothUser });
      expect(await outcomeOf(c, l2)).toMatchObject({ outcome: 'recoded', final_gl_account_id: A.other });
    });
  });

  it('excluding a line with an open suggestion rejects it', async () => {
    const l = await seedLine(A);
    await asUser(bothUser, A.id, async (c) => {
      await recordSuggestionsShown(A.id, [{ txId: l, source: 'rule', glAccountId: A.expense }]);
      await recordExcluded(A.id, l, bothUser);
      expect((await outcomeOf(c, l))!.outcome).toBe('rejected');
    });
  });

  it('an auto-post takes over the pending row; an undo marks it undone; a hand correction recodes it', async () => {
    const l1 = await seedLine(A);
    const l2 = await seedLine(A);
    await asUser(bothUser, A.id, async (c) => {
      const je1 = crypto.randomUUID();
      const je2 = crypto.randomUUID();
      await recordSuggestionsShown(A.id, [{ txId: l1, source: 'pattern', glAccountId: A.expense }]);
      await recordAutoPosted(A.id, { txId: l1, source: 'pattern', glAccountId: A.expense, confidence: 0.97, journalEntryId: je1, target: 'suggestion', triggeredBy: bothUser });
      await recordAutoPosted(A.id, { txId: l2, source: 'rule', glAccountId: A.expense, journalEntryId: je2, target: 'own' });
      expect(await outcomeOf(c, l1)).toMatchObject({ outcome: 'accepted', was_auto_posted: true, decided_by: null });
      const rows = (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM categorization_decisions WHERE bank_transaction_id = $1', [l1])).rows[0]!.n;
      expect(rows).toBe(1); // the pending row became the auto-posted decision; no second row
      await recordAutoPostUndone(A.id, l1, bothUser, { journalEntryId: je1 });
      await recordHandCorrected(A.id, l2, bothUser, { journalEntryId: je2 });
      expect(await outcomeOf(c, l1)).toMatchObject({ outcome: 'undone', decided_by: bothUser });
      expect((await outcomeOf(c, l2))!.outcome).toBe('recoded');
    });
  });

  it('naming B\'s line while working in A writes nothing and does not throw', async () => {
    await asUser(bothUser, A.id, async (c) => {
      await recordSuggestionsShown(A.id, [{ txId: lineB, source: 'pattern', glAccountId: A.expense }]);
      await recordSuggestionsShown(B.id, [{ txId: lineB, source: 'pattern', glAccountId: B.expense }]);
      // The request transaction is still usable: the failed write rolled back to its own savepoint.
      const n = (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM categorization_decisions WHERE bank_transaction_id = $1 AND suggestion_source = $2', [lineB, 'pattern'])).rows[0]!.n;
      expect(n).toBe(0);
    });
  });
});
