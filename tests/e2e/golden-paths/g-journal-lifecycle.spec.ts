/**
 * Golden path (g): journal draft → post → reverse.
 *
 * Known-good at baseline (July-4 audit: Journals PASS) — this spec PINS the
 * behavior so regressions surface immediately. Also pins that unbalanced
 * journals are rejected.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('journal entry: draft → post → reverse nets to zero', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    // Borrow two GL accounts that already accept postings in this company.
    const posted = await api.get<{ entries: any[] }>(
      '/api/accounting/journal-entries?status=posted&limit=1',
    );
    expect(posted.entries.length, 'Demo company must have at least one posted journal').toBeGreaterThan(0);
    const sample = await api.get<{ lines: any[] }>(
      `/api/accounting/journal-entries-detail?id=${posted.entries[0].id}`,
    );
    expect(sample.lines.length).toBeGreaterThanOrEqual(2);
    const acctA = sample.lines[0].glAccountId;
    const acctB = sample.lines[1].glAccountId;

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
