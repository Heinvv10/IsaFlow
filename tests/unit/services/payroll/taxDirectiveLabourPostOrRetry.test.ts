/**
 * taxDirectiveLabour#postOrRetry (review of 82a26fd4a3): since the split is
 * re-read AFTER the payment claim, a mapped account deactivated before that
 * re-read is absorbed (it posts to 5200). Only a deactivation between the
 * re-read and the GL post reaches postOrRetry, which no integration test can
 * hit deterministically, so the decision is pinned here: the retryable 409 is
 * raised only when EVERY account the GL refused is a mapped labour account of
 * this split that no credit line uses; anything else is rethrown unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CODES: Record<string, string> = { 'acct-5200': '5200', 'acct-5210': '5210', 'acct-5220': '5220', 'acct-2140': '2140', 'acct-1110': '1110' };
const asked: unknown[][] = [];
vi.mock('@/lib/neon', () => ({
  sql: (_s: TemplateStringsArray, ...values: unknown[]) => {
    asked.push(values);
    const ids = (values.find(Array.isArray) as string[] | undefined) ?? [];
    return Promise.resolve(ids.filter((id) => CODES[id]).map((id) => ({ account_code: CODES[id] })));
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { postOrRetry } from '@/modules/accounting/services/payroll/taxDirectiveLabour';
import { InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { TaxDirectiveSplitChangedError } from '@/modules/accounting/services/payroll/taxDirectiveErrors';

const line = (glAccountId: string, debit: number, credit: number) => ({ glAccountId, debit, credit, description: 'd' });
const LINES = [line('acct-5210', 600, 0), line('acct-5220', 300, 0), line('acct-5200', 100, 0), line('acct-2140', 0, 180), line('acct-1110', 0, 820)];
const refused = (...codes: string[]) => new InactiveAccountError(codes.map((code) => ({ code, name: `Account ${code}` })));
const run = (err: Error, lines = LINES) => postOrRetry('co-1', 'dir-1', lines, 'acct-5200', async () => { throw err; });

beforeEach(() => { asked.length = 0; });

describe('postOrRetry', () => {
  it('passes a successful write through', async () => {
    expect(await postOrRetry('co-1', 'dir-1', LINES, 'acct-5200', async () => 'posted')).toBe('posted');
  });

  it('every refused account is a mapped labour account: the retryable TaxDirectiveSplitChangedError', async () => {
    await expect(run(refused('5210'))).rejects.toBeInstanceOf(TaxDirectiveSplitChangedError);
    await expect(run(refused('5210', '5220'))).rejects.toBeInstanceOf(TaxDirectiveSplitChangedError);
    expect(asked.at(-1)).toContain('co-1'); // the account read is company-scoped
  });

  it.each([
    ['2140 alone', ['2140']],
    ['the bank alone', ['1110']],
    ['the default labour account', ['5200']],
    ['a mapped account together with 2140', ['5210', '2140']],
  ])('%s: rethrown as the same InactiveAccountError', async (_label, codes) => {
    const err = refused(...codes);
    await expect(run(err)).rejects.toBe(err);
  });

  it('labour mapped to an account a credit line also uses (the bank): rethrown — the retry would fail the same way', async () => {
    const err = refused('1110');
    await expect(run(err, [line('acct-1110', 1000, 0), line('acct-2140', 0, 180), line('acct-1110', 0, 820)])).rejects.toBe(err);
  });

  it('an InactiveAccountError naming no account: rethrown', async () => {
    const err = refused();
    await expect(run(err)).rejects.toBe(err);
  });

  it('any other error: rethrown untouched, nothing read', async () => {
    const err = new Error('numbering lock timeout');
    await expect(run(err)).rejects.toBe(err);
    expect(asked).toHaveLength(0);
  });
});
