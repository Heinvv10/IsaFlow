/**
 * The contract obligations on the two reclassification tools.
 *
 * These are the ones that are invisible in the happy path and expensive when
 * wrong: a dry run that consumes the idempotency key serves the preview to the
 * real call forever; a refusal that is not pre-write frees the key AND keeps
 * what it wrote; a `toolError` that names the tenant is an existence oracle.
 *
 * The plan layer is mocked here on purpose — its behaviour is covered by
 * `reclassificationCandidates.test.ts` and by the DB-gated
 * `reclassificationDb.test.ts`. What is under test is the tool's own decisions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  planReclassification: vi.fn(),
  postReclassBatch: vi.fn(),
}));
const { planReclassification, postReclassBatch } = mocks;

vi.mock('@/modules/accounting/services/gl/reclassification/plan', async (orig) => {
  const actual = await orig<typeof import(
    '@/modules/accounting/services/gl/reclassification/plan')>();
  return { ...actual, planReclassification: mocks.planReclassification };
});
vi.mock('@/modules/accounting/services/gl/reclassification/post', () => ({
  postReclassBatch: mocks.postReclassBatch,
}));

import { proposeReclassificationTool } from '@/lib/mcp/tools/reclassificationPropose';
import { postReclassificationBatchTool } from '@/lib/mcp/tools/writeReclassification';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import { GlAccountLockTimeoutError } from '@/modules/accounting/services/gl/glAccountLock';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  scopes: ['read:reports', 'write:journals', 'write:post'],
  tokenJti: 'jti-1',
  oauthAppId: null,
} as unknown as McpToolContext;

const SRC = '22222222-2222-4222-8222-222222222222';
const TGT = '33333333-3333-4333-8333-333333333333';

function account(id: string, code: string, name: string, subtype: string | null) {
  return { id, code, name, type: 'expense' as const, subtype, isActive: true };
}

function plan(over: Record<string, unknown> = {}) {
  const movable = [{
    lineId: 'l1', journalEntryId: 'e1', entryNumber: 'JE-1', entryDate: '2026-04-15',
    debit: 1000, credit: 0, description: 'cable', projectId: null, costCenterId: null,
  }];
  return {
    source: account(SRC, '49775627', 'Unallocated Expense', null),
    target: account(TGT, '5100', 'Materials & Supplies', 'operating_expense'),
    movable,
    skipped: [{
      lineId: 'l2', journalEntryId: 'e2', entryNumber: 'JE-2', entryDate: '2026-01-05',
      amount: 500, reason: 'source_period_closed' as const,
    }],
    universeTotal: 2,
    drafts: [{
      date: '2026-04-15', description: 'Reclassification: 49775627 → 5100',
      lines: [
        { glAccountId: SRC, debit: 0, credit: 1000, description: 'out' },
        { glAccountId: TGT, debit: 1000, credit: 0, description: 'in' },
      ],
      sourceLineIds: ['l1'], totalDebit: 1000, totalCredit: 1000,
    }],
    impact: {
      window: { start: '2026-01-05', end: '2026-04-15' },
      profitAndLossBefore: { operatingExpenses: 0 },
      profitAndLossAfter: { operatingExpenses: 1000 },
      accounts: [],
    },
    warnings: [{ code: 'subtype_remedy_available', detail: 'set the subtype instead' }],
    postedThrough: '2026-04-16T00:00:00.000Z',
    postingDate: null,
    ...over,
  };
}

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

beforeEach(() => {
  planReclassification.mockReset();
  postReclassBatch.mockReset();
});

describe('propose_reclassification', () => {
  it('is a READ tool: it never writes and costs nothing', () => {
    expect(proposeReclassificationTool.write).toBe(false);
    expect(proposeReclassificationTool.requiresPost).toBeUndefined();
  });

  it('returns a sound envelope whose universe is counted, not synthesized', async () => {
    planReclassification.mockResolvedValue(plan());
    const out = parse(await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    ) as never);
    expect(out.rowsTotal).toBe(1);
    expect(out.excludedRows).toHaveLength(1);
    expect(out.universeTotal).toBe(2);
    assertEnvelopeSound(out);
  });

  it('carries the collapse caveat into the response, not only the description', async () => {
    planReclassification.mockResolvedValue(plan());
    const out = parse(await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    ) as never);
    expect(out.warnings.map((w: { code: string }) => w.code))
      .toContain('subtype_remedy_available');
  });

  it('reports gross and net separately, and the route to the source journals', async () => {
    planReclassification.mockResolvedValue(plan());
    const out = parse(await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    ) as never);
    expect(out.movement.grossMoved).toBe(1000);
    expect(out.movement.netMoved).toBe(1000);
    expect(out.movement.sourceJournalEntryIds).toEqual(['e1']);
  });

  it('serves the journals themselves at detail "full" — not a count of them', async () => {
    planReclassification.mockResolvedValue(plan());
    const out = parse(await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT, detail: 'full' }, CTX,
    ) as never);
    expect(out.journals[0].lines).toHaveLength(2);
    expect(out.journals[0].lines[0].accountCode).toBe('49775627');
  });

  it('answers a cross-tenant id with the shared generic text', async () => {
    planReclassification.mockResolvedValue({ refused: 'NOT_FOUND' });
    const out = await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe('Not found');
  });

  it('refuses an unusable uuid before any query runs', async () => {
    const out = await proposeReclassificationTool.handler(
      { source_account_id: 'nope', target_account_id: TGT }, CTX,
    );
    expect(out.isError).toBe(true);
    expect(planReclassification).not.toHaveBeenCalled();
  });

  it('renders a GL account lock timeout as the refusal that names the account', async () => {
    // Both of the plan's locks are taken before anything is posted, so a
    // timeout on either is write-free and belongs in the pre-write catch.
    // Uncaught, `registry.call` renders it as GENERIC_FAILURE — "the operation
    // failed" — and the wording that tells the agent WHICH account is busy, and
    // that a retry is the answer, is discarded. `writeMergeGlAccounts` matches
    // the same code for the same reason.
    planReclassification.mockRejectedValue(new GlAccountLockTimeoutError(TGT));
    const out = await proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain(TGT);
    expect(out.content[0]!.text).toContain('retry');
  });

  it('still rethrows a failure that is not one of the two known write-free locks', async () => {
    planReclassification.mockRejectedValue(new Error('connection terminated'));
    await expect(proposeReclassificationTool.handler(
      { source_account_id: SRC, target_account_id: TGT }, CTX,
    )).rejects.toThrow('connection terminated');
  });
});

describe('post_reclassification_batch', () => {
  it('is a posting tool and takes both mutation arguments', () => {
    expect(postReclassificationBatchTool.write).toBe(true);
    expect(postReclassificationBatchTool.requiresPost).toBe(true);
    const props = postReclassificationBatchTool.inputSchema.properties as Record<string, unknown>;
    expect(props.dry_run).toBeDefined();
    expect(props.idempotency_key).toBeDefined();
    // dry_run has no default, so it is false — a default-true dry run reads as
    // a safety improvement and is not one.
    expect((props.dry_run as { default?: unknown }).default).toBeUndefined();
    expect(postReclassificationBatchTool.inputSchema.required).toContain('idempotency_key');
  });

  it('a dry run writes nothing, frees the key, and is not billed', async () => {
    planReclassification.mockResolvedValue(plan());
    const out = await postReclassificationBatchTool.handler(
      { source_account_id: SRC, target_account_id: TGT, idempotency_key: 'k1', dry_run: true },
      CTX,
    );
    expect(postReclassBatch).not.toHaveBeenCalled();
    // Without this the real call that follows is served the preview forever.
    expect(out.wroteNothing).toBe(true);
    expect(out.billable).toBe(false);
    const body = parse(out as never);
    expect(body.dryRun).toBe(true);
    expect(body.batch_id).toBeNull();
    // The journals, and the skips, and the same warnings the live call gives.
    expect(body.journals[0].lines).toHaveLength(2);
    expect(body.skipped[0].reason).toBe('source_period_closed');
    expect(body.warnings).toHaveLength(1);
  });

  it('the dry run gives the IDENTICAL refusal the live call gives', async () => {
    // A dry run that succeeds where the real call refuses is the forbidden
    // direction: an agent branching on `isError` would get opposite answers
    // from a preview and the call it previews.
    planReclassification.mockResolvedValue(plan({ movable: [], drafts: [] }));
    const args = { source_account_id: SRC, target_account_id: TGT, idempotency_key: 'k' };
    const dry = await postReclassificationBatchTool.handler({ ...args, dry_run: true }, CTX);
    const live = await postReclassificationBatchTool.handler(args, CTX);

    expect(dry.isError).toBe(true);
    expect(live.isError).toBe(true);
    expect(dry.content[0]!.text).toBe(live.content[0]!.text);
    expect(dry.content[0]!.text).toContain('source_period_closed');
    expect(postReclassBatch).not.toHaveBeenCalled();
  });

  it('opens NO batch when nothing is movable — a silent posted:0 reads as done', async () => {
    planReclassification.mockResolvedValue(plan({ movable: [], drafts: [] }));
    const out = await postReclassificationBatchTool.handler(
      { source_account_id: SRC, target_account_id: TGT, idempotency_key: 'k' }, CTX,
    );
    expect(out.isError).toBe(true);
    // Pre-write, so it is a toolError and the registry audits it with a NULL
    // key — the agent can retry on the same key once it has fixed its window.
    expect(out.wroteNothing).toBeUndefined();
  });

  it('does NOT catch a failure from the write path', async () => {
    planReclassification.mockResolvedValue(plan());
    postReclassBatch.mockRejectedValue(new Error('period closed'));
    // A catch here would RELEASE the registry's savepoint and let the transport
    // commit the journals already posted, while freeing the key for a retry
    // that posts them again.
    await expect(postReclassificationBatchTool.handler(
      { source_account_id: SRC, target_account_id: TGT, idempotency_key: 'k' }, CTX,
    )).rejects.toThrow('period closed');
  });

  it('returns the batch id, the journal ids and the documented undo route', async () => {
    planReclassification.mockResolvedValue(plan());
    postReclassBatch.mockResolvedValue({
      batchId: 'b1',
      journals: [{ journalEntryId: 'je1', entryNumber: 'JE-9', date: '2026-04-15',
        fiscalPeriodId: 'fp1', lineCount: 2, totalDebit: 1000, totalCredit: 1000 }],
      movedLineCount: 1,
    });
    const out = parse(await postReclassificationBatchTool.handler(
      { source_account_id: SRC, target_account_id: TGT, idempotency_key: 'k' }, CTX,
    ) as never);
    expect(out.batch_id).toBe('b1');
    expect(out.journal_entry_ids).toEqual(['je1']);
    expect(out.moved_lines).toBe(1);
    expect(out.reverse_with).toContain('reverse_journal_entry');
    // Every posted journal is stamped as the agent.
    expect(postReclassBatch.mock.calls[0]![2].actor.actorType).toBe('agent');
    expect(postReclassBatch.mock.calls[0]![2].actor.postingAgent)
      .toBe('mcp:post_reclassification_batch:v1');
  });
});
