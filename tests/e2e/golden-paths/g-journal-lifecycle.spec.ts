/**
 * Golden path (g): journal draft → post → reverse.
 *
 * Known-good at baseline (July-4 audit: Journals PASS) — this spec PINS the
 * behavior so regressions surface immediately. Also pins that unbalanced
 * journals are rejected.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

/**
 * Two GL accounts that already accept postings in this company: the first two lines of its latest posted journal.
 * A company with no posted journal yet (a golden slot before its first run: slots copy setup data, never
 * transactions) uses its default expense account and its first bank account instead. This very test posts a journal, so
 * the fallback is only ever taken once per company.
 */
async function postableAccounts(api: Api): Promise<[string, string]> {
  const posted = await api.get<{ entries: any[] }>('/api/accounting/journal-entries?status=posted&limit=1');
  if (posted.entries.length > 0) {
    const sample = await api.get<{ lines: any[] }>(
      `/api/accounting/journal-entries-detail?id=${posted.entries[0].id}`,
    );
    expect(sample.lines.length).toBeGreaterThanOrEqual(2);
    return [sample.lines[0].glAccountId, sample.lines[1].glAccountId];
  }
  const expense = await api.get<any[]>('/api/accounting/chart-of-accounts?subtype=default_expense');
  const banks = await api.get<any[]>('/api/accounting/bank-accounts');
  const expenseId = expense.find((a) => a.isSystemAccount === true)?.id;
  expect(expenseId, 'a company with no posted journal needs a default expense account to borrow').toBeTruthy();
  expect(banks.length, 'a company with no posted journal needs a bank account to borrow').toBeGreaterThan(0);
  return [expenseId, banks[0].id];
}

test('journal entry: draft → post → reverse nets to zero', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const [acctA, acctB] = await postableAccounts(api);

    // Unbalanced journal must be rejected (pin: validation known-good).
    const unbalanced = await api.postRaw('/api/accounting/journal-entries', {
      entryDate: today(),
      description: gpRef('JNL-UNBAL'),
      lines: [
        { glAccountId: acctA, debit: 100, credit: 0 },
        { glAccountId: acctB, debit: 0, credit: 99 },
      ],
    });
    expect(unbalanced.status, 'unbalanced journal must be rejected').toBeGreaterThanOrEqual(400);

    // Draft.
    const ref = gpRef('JNL');
    const entry = await api.post<any>('/api/accounting/journal-entries', {
      entryDate: today(),
      description: ref,
      lines: [
        { glAccountId: acctA, debit: 123.45, credit: 0, description: `${ref} dr` },
        { glAccountId: acctB, debit: 0, credit: 123.45, description: `${ref} cr` },
      ],
    });
    expect(entry.id).toBeTruthy();
    expect(entry.status).toBe('draft');

    // Post.
    await api.post('/api/accounting/journal-entries-action', { id: entry.id, action: 'post' });
    const afterPost = await api.get<any>(`/api/accounting/journal-entries-detail?id=${entry.id}`);
    expect(afterPost.status).toBe('posted');

    // Reverse. Semantics (PR #197): the original KEEPS status='posted' —
    // reversal is metadata (reversed_at + reversal_of_id on the contra) so
    // posted-only readers see the pair net to zero, not the contra alone.
    const reversal = await api.post<any>('/api/accounting/journal-entries-action', {
      id: entry.id,
      action: 'reverse',
    });
    expect(reversal.id).toBeTruthy();
    expect(reversal.id).not.toBe(entry.id);

    const original = await api.get<any>(`/api/accounting/journal-entries-detail?id=${entry.id}`);
    expect(original.status, 'original stays posted — reversal is metadata').toBe('posted');
    expect(original.reversedAt, 'original carries reversed_at').toBeTruthy();

    const reversalDetail = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${reversal.id}`,
    );
    expect(reversalDetail.reversalOfId).toBe(entry.id);
    expect(reversalDetail.status).toBe('posted');

    // Pair nets to zero: reversal lines mirror the original's debits/credits.
    const sum = (lines: any[], k: 'debit' | 'credit') =>
      lines.reduce((t, l) => t + Number(l[k]), 0);
    expect(sum(reversalDetail.lines, 'debit')).toBeCloseTo(sum(original.lines, 'credit'), 2);
    expect(sum(reversalDetail.lines, 'credit')).toBeCloseTo(sum(original.lines, 'debit'), 2);
  } finally {
    await api.dispose();
  }
});
