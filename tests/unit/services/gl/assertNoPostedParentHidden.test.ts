/**
 * assertNoPostedParentHidden (gl/accountParentRules) with the database and the account lock stubbed: the order
 * it does things in (find the at-risk accounts, lock them, re-read with the lines check) and what it binds.
 * Which accounts are at risk is the integration suites' question (header-account-chart-edits.int.test.ts, and
 * header-account-chart-edit-race.int.test.ts for the lock itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const queries: unknown[][] = [];
let answers: unknown[][] = [];

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push('query');
    queries.push(values);
    return answers[queries.length - 1] ?? [];
  }),
}));
vi.mock('@/modules/accounting/services/gl/glAccountLock', () => ({
  lockGlAccountsForUpdate: vi.fn(async () => { calls.push('lock'); }),
}));

import { ParentAccountError, assertNoPostedParentHidden } from '@/modules/accounting/services/gl/accountParentRules';
import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const AT_RISK = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const DELTA = -2; // not a number the SQL binds anywhere else (3 is the leaf level, 32 the depth cap)
const candidates = AT_RISK.map((id, i) => ({ id, account_code: `C${i}` }));

beforeEach(() => {
  calls.length = 0;
  queries.length = 0;
  answers = [];
  vi.mocked(lockGlAccountsForUpdate).mockClear();
});

describe('assertNoPostedParentHidden', () => {
  it('no candidates: no lock and no second query', async () => {
    answers = [[]];
    await expect(assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA)).resolves.toBeUndefined();
    expect(calls).toEqual(['query']);
    expect(lockGlAccountsForUpdate).not.toHaveBeenCalled();
  });

  it('candidates: locks exactly their ids for the company, between the two queries', async () => {
    answers = [candidates, []];
    await assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA);
    expect(lockGlAccountsForUpdate).toHaveBeenCalledTimes(1);
    expect(lockGlAccountsForUpdate).toHaveBeenCalledWith(COMPANY, AT_RISK);
    expect(calls).toEqual(['query', 'lock', 'query']);
  });

  it('the second query returns a row: throws ParentAccountError naming the code and "above level 3"', async () => {
    answers = [candidates, [{ id: AT_RISK[1], account_code: 'C1' }]];
    const err = await assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ParentAccountError);
    expect((err as Error).message).toContain('would put C1 above level 3');
  });

  it('the second query returns none: resolves', async () => {
    answers = [candidates, []];
    await expect(assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA)).resolves.toBeUndefined();
  });

  it('both queries bind the delta, the leaf level, the moved account and the company', async () => {
    answers = [candidates, []];
    await assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA);
    expect(queries).toHaveLength(2);
    for (const values of queries) {
      expect(values.filter((v) => v === DELTA)).toHaveLength(1);
      expect(values.filter((v) => v === 3)).toHaveLength(2); // the lower bound and the bound after the move
      expect(values).toContain(ACCOUNT);
      expect(values.filter((v) => v === COMPANY).length).toBeGreaterThanOrEqual(4);
      expect(values).toContainEqual(['asset', 'liability', 'equity']);
    }
  });

  it('the lines check is off in the first query and on in the second', async () => {
    answers = [candidates, []];
    await assertNoPostedParentHidden(COMPANY, ACCOUNT, DELTA);
    // The only boolean bound is `NOT withLines`: true skips the lines test.
    expect(queries.map((values) => values.filter((v) => typeof v === 'boolean'))).toEqual([[true], [false]]);
  });
});
