/**
 * Unit tests for the Close Agent v1 pure proposal builder + honesty guards.
 *
 * The builder is PURE (no DB): given a period's readiness checklist and the
 * concrete actionable rows, it emits typed proposals — some the agent can
 * execute on one-click approval (auto_post), some it can only flag with
 * evidence for a human to clear (advisory). Nothing here posts anything; the
 * honesty rules (P5.3) are enforced by validateDecision.
 *
 * Coverage:
 *  1. Each draft journal → one auto_post 'post_draft_journal' proposal.
 *  2. Every proposal carries non-empty reasoning + evidence (honesty).
 *  3. auto_post proposals target the gl_journal_entry by id.
 *  4. Failing/warning readiness items → advisory proposals (except unposted_journals when drilled down).
 *  5. unposted_journals advisory is suppressed when draft journals are present (drilled into auto_post).
 *  6. Passing readiness items produce no proposal.
 *  7. Ordering: auto_post first, then advisory fail-before-warn.
 *  8. Advisory evidence carries the readiness reason + fixHref.
 *  9. validateDecision: only 'proposed' proposals are decidable.
 * 10. validateDecision: advisory proposals reject 'approve' (never post).
 * 11. validateDecision: advisory accepts 'dismiss'; auto_post accepts approve/reject.
 * 12. computeAccuracy: posted/(posted+rejected) over auto_post; null when denominator 0.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProposals,
  validateDecision,
  computeAccuracy,
} from '@/modules/accounting/services/gl/closeRun/closeRunProposalBuilder';
import type {
  ActionableCloseState,
  DraftJournalRow,
  ProposalDraft,
} from '@/modules/accounting/services/gl/closeRun/closeRunTypes';
import type { CloseReadiness, ChecklistItem } from '@/modules/accounting/services/gl/periodCloseReadinessService';

const draftJe = (over: Partial<DraftJournalRow> = {}): DraftJournalRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  entryNumber: 'JE-2026-00042',
  entryDate: '2026-07-15',
  description: 'Accrual — July electricity',
  totalDebit: 1500,
  lineCount: 2,
  ...over,
});

const item = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  key: 'bank_reconciled',
  label: 'Bank reconciled',
  status: 'fail',
  reason: '3 bank transactions still unreconciled.',
  fixHref: '/accounting/bank-transactions',
  ...over,
});

const readiness = (items: ChecklistItem[]): CloseReadiness => ({
  periodId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  periodLabel: 'July 2026',
  items,
  overallStatus: items.some(i => i.status === 'fail') ? 'fail' : items.some(i => i.status === 'warn') ? 'warn' : 'pass',
});

const emptyActionable = (): ActionableCloseState => ({ draftJournals: [] });

describe('buildProposals', () => {
  it('emits one auto_post proposal per draft journal, targeting the je', () => {
    const r = readiness([item({ key: 'unposted_journals', label: 'Unposted journals', reason: '1 draft journal.' })]);
    const props = buildProposals(r, { draftJournals: [draftJe()] });
    const autoPosts = props.filter(p => p.actionType === 'auto_post');
    expect(autoPosts).toHaveLength(1);
    const p = autoPosts[0]!;
    expect(p.kind).toBe('post_draft_journal');
    expect(p.targetEntityType).toBe('gl_journal_entry');
    expect(p.targetEntityId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('gives every proposal non-empty reasoning and evidence', () => {
    const r = readiness([
      item({ key: 'bank_reconciled', status: 'fail' }),
      item({ key: 'vat_reviewed', label: 'VAT reviewed', status: 'warn', reason: 'No VAT return drafted.', fixHref: '/accounting/reports/vat-return' }),
    ]);
    const props = buildProposals(r, { draftJournals: [draftJe()] });
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(p.reasoning.trim().length).toBeGreaterThan(0);
      expect(p.evidence.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('maps failing/warning readiness items to advisory proposals', () => {
    const r = readiness([
      item({ key: 'bank_reconciled', status: 'fail' }),
      item({ key: 'ar_ties', label: 'AR sub-ledger ties to GL', status: 'warn', reason: 'AR off by R0.50.', fixHref: '/accounting/customer-invoices' }),
    ]);
    const props = buildProposals(r, emptyActionable());
    const advisory = props.filter(p => p.actionType === 'advisory');
    expect(advisory.map(p => p.kind).sort()).toEqual(['ar_untied', 'bank_unreconciled']);
    const bank = advisory.find(p => p.kind === 'bank_unreconciled')!;
    expect(bank.evidence.summary).toContain('unreconciled');
    expect(bank.evidence.fixHref).toBe('/accounting/bank-transactions');
  });

  it('suppresses the unposted_journals advisory once drilled into auto_post proposals', () => {
    const r = readiness([item({ key: 'unposted_journals', label: 'Unposted journals', status: 'fail', reason: '2 draft journals.' })]);
    const props = buildProposals(r, { draftJournals: [draftJe(), draftJe({ id: '22222222-2222-2222-2222-222222222222', entryNumber: 'JE-2026-00043' })] });
    expect(props.filter(p => p.kind === 'unposted_journals')).toHaveLength(0);
    expect(props.filter(p => p.kind === 'post_draft_journal')).toHaveLength(2);
  });

  it('keeps the unposted_journals advisory when the check fails but no drafts were fetched', () => {
    const r = readiness([item({ key: 'unposted_journals', label: 'Unposted journals', status: 'fail', reason: 'Could not compute.' })]);
    const props = buildProposals(r, emptyActionable());
    expect(props.filter(p => p.kind === 'unposted_journals')).toHaveLength(1);
  });

  it('produces no proposal for passing readiness items', () => {
    const r = readiness([
      item({ key: 'bank_reconciled', status: 'pass', reason: 'All reconciled.' }),
      item({ key: 'tb_balanced', label: 'Trial balance balanced', status: 'pass', reason: 'Balanced.' }),
    ]);
    const props = buildProposals(r, emptyActionable());
    expect(props).toHaveLength(0);
  });

  it('orders auto_post proposals before advisory, fail before warn', () => {
    const r = readiness([
      item({ key: 'vat_reviewed', label: 'VAT reviewed', status: 'warn', reason: 'No return.', fixHref: '/x' }),
      item({ key: 'bank_reconciled', status: 'fail' }),
    ]);
    const props = buildProposals(r, { draftJournals: [draftJe()] });
    expect(props[0]!.actionType).toBe('auto_post');
    const advisory = props.filter(p => p.actionType === 'advisory');
    expect(advisory[0]!.kind).toBe('bank_unreconciled'); // fail before warn
    expect(advisory[1]!.kind).toBe('vat_unreviewed');
  });
});

describe('validateDecision (honesty guard — nothing posts without explicit approval)', () => {
  const autoPost: Pick<ProposalDraft, 'actionType'> & { status: string } = { actionType: 'auto_post', status: 'proposed' };
  const advisory: Pick<ProposalDraft, 'actionType'> & { status: string } = { actionType: 'advisory', status: 'proposed' };

  it('rejects a decision on an already-decided proposal', () => {
    const res = validateDecision({ actionType: 'auto_post', status: 'posted' }, 'approve');
    expect(res.ok).toBe(false);
  });

  it('rejects approve on an advisory proposal (advisory items never post)', () => {
    const res = validateDecision(advisory, 'approve');
    expect(res.ok).toBe(false);
  });

  it('accepts dismiss on an advisory proposal', () => {
    expect(validateDecision(advisory, 'dismiss').ok).toBe(true);
  });

  it('accepts approve and reject on an auto_post proposal', () => {
    expect(validateDecision(autoPost, 'approve').ok).toBe(true);
    expect(validateDecision(autoPost, 'reject').ok).toBe(true);
  });
});

describe('computeAccuracy (proposed vs accepted, shown honestly)', () => {
  it('is null when no auto_post proposal was ever decided', () => {
    const acc = computeAccuracy({ proposed: 5, approved: 0, posted: 0, rejected: 0, failed: 0, dismissed: 3 });
    expect(acc.acceptanceRate).toBeNull();
  });

  it('computes posted / (posted + rejected)', () => {
    const acc = computeAccuracy({ proposed: 10, approved: 8, posted: 8, rejected: 2, failed: 0, dismissed: 0 });
    expect(acc.acceptanceRate).toBeCloseTo(0.8, 5);
    expect(acc.decided).toBe(10);
  });

  it('excludes failed posts from the acceptance denominator but reports them', () => {
    const acc = computeAccuracy({ proposed: 6, approved: 5, posted: 4, rejected: 1, failed: 1, dismissed: 0 });
    expect(acc.acceptanceRate).toBeCloseTo(4 / 5, 5);
    expect(acc.failed).toBe(1);
  });
});
