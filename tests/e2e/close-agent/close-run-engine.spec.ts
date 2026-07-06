/**
 * Close Agent v1 — engine integration (HTTP-only, no browser).
 *
 * Exercises the real close-run engine against the DB through the API, covering
 * what the mocked-repo unit tests cannot: the interaction between the 409 error
 * mapping and withAuth's commit-on-<500. Specifically it proves the savepoint
 * compensation — a failed approve leaves the proposal RETRYABLE ('proposed'),
 * never orphaned in 'approved'.
 *
 * Run:
 *   BASE_URL=http://localhost:3200 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
 *   bunx playwright test tests/e2e/close-agent/close-run-engine.spec.ts --config playwright-standalone.config.ts
 */
import { test, expect } from '@playwright/test';
import { Api } from '../golden-paths/_api';

const CLOSE_AGENT = 'close-agent:v1';

async function pickSandboxPeriod(api: Api): Promise<{ id: string }> {
  for (const year of [2027, 2028, 2029]) {
    const periods = await api.get<Array<{ id: string; status: string }>>(`/api/accounting/fiscal-periods?year=${year}`);
    const open = periods.find(p => p.status === 'open');
    if (open) return { id: open.id };
  }
  throw new Error('No open sandbox period in 2027–2029');
}

async function borrowTwoAccounts(api: Api): Promise<[string, string]> {
  const posted = await api.get<{ entries: Array<{ id: string }> }>('/api/accounting/journal-entries?status=posted&limit=1');
  const detail = await api.get<{ lines: Array<{ glAccountId: string }> }>(`/api/accounting/journal-entries-detail?id=${posted.entries[0]!.id}`);
  return [detail.lines[0]!.glAccountId, detail.lines[1]!.glAccountId];
}

test('close-run engine: propose → approve posts+audits, and a failed approve stays retryable', async ({ baseURL }) => {
  test.setTimeout(90_000);
  const api = await Api.login(baseURL!);
  const jeIds: string[] = [];
  const tag = `CRE-${Date.now().toString(36)}`;

  try {
    const period = await pickSandboxPeriod(api);
    const [a, b] = await borrowTwoAccounts(api);
    const seed = async (n: number) => {
      const je = await api.post<{ id: string }>('/api/accounting/journal-entries', {
        entryDate: `${(await periodMonth(api, period.id))}-15`,
        description: `${tag} draft ${n}`, source: 'manual', fiscalPeriodId: period.id,
        lines: [{ glAccountId: a, debit: 50 * n, credit: 0 }, { glAccountId: b, debit: 0, credit: 50 * n }],
      });
      jeIds.push(je.id);
      return je.id;
    };
    const je1 = await seed(1);
    const je2 = await seed(2);

    // Start the run — both drafts become auto_post proposals.
    const run = await api.post<{ run: { id: string }; proposals: Array<{ id: string; kind: string; actionType: string; targetEntityId: string | null; status: string }> }>(
      '/api/accounting/close-run', { periodId: period.id },
    );
    const autoPost = run.proposals.filter(p => p.actionType === 'auto_post');
    expect(autoPost.length).toBeGreaterThanOrEqual(2);
    const p1 = autoPost.find(p => p.targetEntityId === je1)!;
    const p2 = autoPost.find(p => p.targetEntityId === je2)!;
    expect(p1 && p2).toBeTruthy();

    // Approve p1 → posts + writes an audit row carrying the reasoning.
    const decided = await api.post<{ proposal: { status: string } }>('/api/accounting/close-run/decide', {
      runId: run.run.id, proposalId: p1.id, decision: 'approve',
    });
    expect(decided.proposal.status).toBe('posted');
    const { items } = await api.get<{ items: Array<{ action: string; changes: { metadata?: Record<string, string> } | null }> }>(
      `/api/accounting/audit-log-entity?type=gl_journal_entry&id=${je1}`,
    );
    const postRow = items.find(it => it.action === 'post' && it.changes?.metadata?.source === CLOSE_AGENT);
    expect(postRow, 'posted JE carries a close-agent audit row').toBeTruthy();
    expect((postRow!.changes!.metadata!.reasoning ?? '').length).toBeGreaterThan(0);

    // Now post je2 OUT OF BAND, then approve p2 → the engine must 409 and leave
    // p2 RETRYABLE ('proposed'), NOT orphaned in 'approved' (the savepoint fix).
    await api.post('/api/accounting/journal-entries-action', { id: je2, action: 'post' });
    const conflict = await api.postRaw('/api/accounting/close-run/decide', {
      runId: run.run.id, proposalId: p2.id, decision: 'approve',
    });
    expect(conflict.status, 'stale approve is a 409, not a 500').toBe(409);

    const after = await api.get<{ proposals: Array<{ id: string; status: string }> }>(`/api/accounting/close-run?runId=${run.run.id}`);
    const p2After = after.proposals.find(p => p.id === p2.id)!;
    expect(p2After.status, 'a failed approve leaves the proposal proposed (retryable), not approved').toBe('proposed');

    // Resolve p2 by rejecting it (its JE is already posted elsewhere) → run can complete.
    await api.post('/api/accounting/close-run/decide', { runId: run.run.id, proposalId: p2.id, decision: 'reject' });
    // Dismiss any advisory items, then complete.
    for (const adv of after.proposals.filter(p => p.status === 'proposed')) {
      if (adv.id === p2.id) continue;
      await api.post('/api/accounting/close-run/decide', { runId: run.run.id, proposalId: adv.id, decision: 'dismiss' }).catch(() => undefined);
    }
    const completed = await api.postRaw('/api/accounting/close-run/complete', { runId: run.run.id });
    // 200 if every item was decided; either way it must not 500.
    expect(completed.status).toBeLessThan(500);
  } finally {
    for (const id of jeIds) {
      await api.post('/api/accounting/journal-entries-action', { id, action: 'reverse' }).catch(() => undefined);
    }
    await api.dispose();
  }
});

async function periodMonth(api: Api, periodId: string): Promise<string> {
  for (const year of [2027, 2028, 2029]) {
    const periods = await api.get<Array<{ id: string; startDate: string }>>(`/api/accounting/fiscal-periods?year=${year}`);
    const hit = periods.find(p => p.id === periodId);
    if (hit) return String(hit.startDate).slice(0, 7);
  }
  throw new Error('period not found');
}
