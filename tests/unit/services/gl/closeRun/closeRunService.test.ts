/**
 * Unit tests for the Close Agent v1 orchestration service.
 *
 * The service composes the readiness service, the pure builder, the posting
 * service, the audit trail and the repo. These tests mock the composed pieces
 * and assert the ORCHESTRATION contract — especially the honesty guarantees:
 *   - approve of an auto_post proposal posts the JE AND writes an audit row
 *     carrying the proposal's reasoning + the close-agent source tag;
 *   - advisory proposals never post;
 *   - a run cannot complete while any proposal is undecided.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/periodCloseReadinessService', () => ({ getCloseReadiness: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({ getFiscalPeriodById: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/closeRun/closeRunRepo', () => ({
  fetchDraftJournals: vi.fn(),
  insertCloseRun: vi.fn(),
  insertProposals: vi.fn(),
  getProposalById: vi.fn(),
  updateProposalOutcome: vi.fn(),
  getCloseRunById: vi.fn(),
  getLatestCloseRunForPeriod: vi.fn(),
  updateCloseRunStatus: vi.fn(),
  getOutcomeCounts: vi.fn(),
}));

import {
  startCloseRun,
  decideProposal,
  completeCloseRun,
  getAccuracy,
  CLOSE_AGENT,
  ProposalDecisionError,
  CloseRunNotFoundError,
} from '@/modules/accounting/services/gl/closeRun/closeRunService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import * as repo from '@/modules/accounting/services/gl/closeRun/closeRunRepo';

const CO = 'co-1';
const USER = 'user-1';
const PERIOD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop-1',
  closeRunId: 'run-1',
  kind: 'post_draft_journal',
  actionType: 'auto_post',
  title: 'Post JE-2026-00042',
  reasoning: 'JE-2026-00042 is a balanced draft journal; posting it is required before close.',
  evidence: { summary: 'x' },
  targetEntityType: 'gl_journal_entry',
  targetEntityId: '11111111-1111-1111-1111-111111111111',
  status: 'proposed',
  decidedBy: null,
  decidedAt: null,
  result: null,
  createdAt: '2026-07-06T00:00:00Z',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('startCloseRun', () => {
  it('composes readiness + drafts into a persisted run with proposals', async () => {
    (getFiscalPeriodById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: PERIOD_ID, startDate: '2026-07-01', endDate: '2026-07-31', periodName: 'July 2026' });
    (getCloseReadiness as ReturnType<typeof vi.fn>).mockResolvedValue({
      periodId: PERIOD_ID, periodLabel: 'July 2026', overallStatus: 'fail',
      items: [{ key: 'unposted_journals', label: 'Unposted journals', status: 'fail', reason: '1 draft.', fixHref: '/x' }],
    });
    (repo.fetchDraftJournals as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '11111111-1111-1111-1111-111111111111', entryNumber: 'JE-2026-00042', entryDate: '2026-07-15', description: 'Accrual', totalDebit: 1500, lineCount: 2 },
    ]);
    (repo.insertCloseRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'run-1', periodLabel: 'July 2026' });
    (repo.insertProposals as ReturnType<typeof vi.fn>).mockImplementation((_c, _r, drafts) => Promise.resolve(drafts.map((d: object, i: number) => ({ ...d, id: `p${i}` }))));

    const res = await startCloseRun(CO, PERIOD_ID, USER);

    expect(res.proposals.filter(p => p.actionType === 'auto_post')).toHaveLength(1);
    expect(repo.insertCloseRun).toHaveBeenCalledWith(CO, PERIOD_ID, 'July 2026', 'fail', USER);
    // draft journals fetched with the period's real date bounds
    expect(repo.fetchDraftJournals).toHaveBeenCalledWith(CO, '2026-07-01', '2026-07-31');
  });

  it('throws CloseRunNotFoundError when the period does not exist', async () => {
    (getFiscalPeriodById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(startCloseRun(CO, PERIOD_ID, USER)).rejects.toBeInstanceOf(CloseRunNotFoundError);
  });
});

describe('decideProposal — approve posts AND audits with reasoning', () => {
  it('posts the journal, then writes an audit row carrying the proposal reasoning', async () => {
    const p = proposal();
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(p);
    (postJournalEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ id: p.targetEntityId, entryNumber: 'JE-2026-00042' });
    (repo.updateProposalOutcome as ReturnType<typeof vi.fn>).mockResolvedValue({ ...p, status: 'posted' });

    const res = await decideProposal(CO, 'run-1', 'prop-1', 'approve', USER);

    expect(postJournalEntry).toHaveBeenCalledWith(CO, p.targetEntityId, USER);
    const auditArg = (logAuditOrThrow as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(auditArg.action).toBe('post');
    expect(auditArg.entityType).toBe('gl_journal_entry');
    expect(auditArg.entityId).toBe(p.targetEntityId);
    expect(auditArg.changes.metadata.reasoning).toBe(p.reasoning);
    expect(auditArg.changes.metadata.source).toBe(CLOSE_AGENT);
    expect(auditArg.changes.metadata.proposalId).toBe('prop-1');
    expect(res.status).toBe('posted');
    // ordering: post must precede audit
    expect((postJournalEntry as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((logAuditOrThrow as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it('does NOT post when the JE posting fails (error propagates, no audit)', async () => {
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(proposal());
    (postJournalEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Cannot post to closed fiscal period'));
    await expect(decideProposal(CO, 'run-1', 'prop-1', 'approve', USER)).rejects.toThrow(/closed fiscal period/);
    expect(logAuditOrThrow).not.toHaveBeenCalled();
    expect(repo.updateProposalOutcome).not.toHaveBeenCalled();
  });

  it('refuses to approve an advisory proposal (advisory never posts)', async () => {
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(proposal({ kind: 'bank_unreconciled', actionType: 'advisory', targetEntityId: null }));
    await expect(decideProposal(CO, 'run-1', 'prop-1', 'approve', USER)).rejects.toBeInstanceOf(ProposalDecisionError);
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('rejects/dismisses without posting', async () => {
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(proposal({ kind: 'bank_unreconciled', actionType: 'advisory', targetEntityId: null }));
    (repo.updateProposalOutcome as ReturnType<typeof vi.fn>).mockResolvedValue(proposal({ status: 'dismissed' }));
    const res = await decideProposal(CO, 'run-1', 'prop-1', 'dismiss', USER);
    expect(res.status).toBe('dismissed');
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(repo.updateProposalOutcome).toHaveBeenCalledWith(CO, 'prop-1', 'dismissed', USER, null);
  });

  it('throws when the proposal does not belong to the run', async () => {
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(proposal({ closeRunId: 'other-run' }));
    await expect(decideProposal(CO, 'run-1', 'prop-1', 'approve', USER)).rejects.toBeInstanceOf(CloseRunNotFoundError);
  });

  it('surfaces an already-decided proposal instead of silently re-posting', async () => {
    (repo.getProposalById as ReturnType<typeof vi.fn>).mockResolvedValue(proposal({ status: 'posted' }));
    await expect(decideProposal(CO, 'run-1', 'prop-1', 'approve', USER)).rejects.toBeInstanceOf(ProposalDecisionError);
  });
});

describe('completeCloseRun', () => {
  it('refuses while any proposal is still undecided', async () => {
    (repo.getCloseRunById as ReturnType<typeof vi.fn>).mockResolvedValue({
      run: { id: 'run-1', status: 'open', periodLabel: 'July 2026' },
      proposals: [proposal({ status: 'proposed' })],
    });
    await expect(completeCloseRun(CO, 'run-1', USER)).rejects.toBeInstanceOf(ProposalDecisionError);
    expect(repo.updateCloseRunStatus).not.toHaveBeenCalled();
  });

  it('completes when all proposals are decided and audits the close', async () => {
    (repo.getCloseRunById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ run: { id: 'run-1', status: 'open', periodLabel: 'July 2026' }, proposals: [proposal({ status: 'posted' }), proposal({ id: 'p2', status: 'dismissed' })] })
      .mockResolvedValueOnce({ run: { id: 'run-1', status: 'completed', periodLabel: 'July 2026' }, proposals: [] });
    const res = await completeCloseRun(CO, 'run-1', USER);
    expect(repo.updateCloseRunStatus).toHaveBeenCalledWith(CO, 'run-1', 'completed');
    expect(logAuditOrThrow).toHaveBeenCalled();
    expect(res.run.status).toBe('completed');
  });
});

describe('getAccuracy', () => {
  it('maps outcome counts through computeAccuracy', async () => {
    (repo.getOutcomeCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ proposed: 4, approved: 3, posted: 3, rejected: 1, failed: 0, dismissed: 2 });
    const acc = await getAccuracy(CO);
    expect(acc.acceptanceRate).toBeCloseTo(0.75, 5);
    expect(acc.dismissed).toBe(2);
  });
});
