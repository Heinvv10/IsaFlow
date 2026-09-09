/**
 * K-043 round-4 review, HIGH-1. Two independent halves of one hole:
 *
 *  - `createRule` had NO rank guard, so a rule could be minted at any rank, and
 *    `updateRule` ranked only the role the rule demanded TODAY, never the one it
 *    was being moved to.
 *  - `requestApproval` took `ruleId` from the request body, so the requester
 *    chose which rule governed their own request.
 *
 * Mocked at the driver: these are decisions about which statement is reached
 * and with what argument, not about what a row contains.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from '@/lib/neon';
import { createRule, updateRule, requestApproval } from '@/modules/accounting/services/gl/approvalService';
import { ApprovalRuleAuthorityError, type RuleActor } from '@/modules/accounting/services/gl/approvalRuleGuards';
import { ApprovalNotRequiredError } from '@/modules/accounting/services/gl/approvalAuthority';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;
const COMPANY = 'company-1';
const actor = (role: string): RuleActor => ({ userId: 'user-1', role, email: 'u@test.local' });

const ruleRow = (over: Record<string, unknown> = {}) => ({
  id: 'rule-1', name: 'a rule', document_type: 'payment', condition_field: 'amount',
  condition_operator: 'any', condition_value: 0, approver_role: 'admin', is_active: true,
  priority: 100, created_at: '2026-01-01', ...over,
});

beforeEach(() => { sqlMock.mockReset(); });

describe('createRule — the rank the new rule will demand', () => {
  it('refuses an admin minting an owner-only rule, before any statement runs', async () => {
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment', approverRole: 'owner' }, actor('admin')))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('ranks the INSERT default when the caller names no role at all', async () => {
    // The INSERT defaults to 'admin'; ranking only what the caller typed would
    // let a manager create an admin-level rule by omitting the field.
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment' }, actor('manager')))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('lets an owner mint the owner-only rule', async () => {
    sqlMock.mockResolvedValueOnce([ruleRow({ approver_role: 'owner' })]);
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment', approverRole: 'owner' }, actor('owner')))
      .resolves.toMatchObject({ approverRole: 'owner' });
  });

  it('lets an admin mint a rule at or below their own rank', async () => {
    sqlMock.mockResolvedValueOnce([ruleRow({ approver_role: 'manager' })]);
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment', approverRole: 'manager' }, actor('admin')))
      .resolves.toMatchObject({ approverRole: 'manager' });
  });

  it('carries no authority for a company role the ladder does not know', async () => {
    await expect(createRule(COMPANY, { name: 'r', documentType: 'payment', approverRole: 'manager' }, actor('Admin')))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });
});

describe('updateRule — the rank the rule is being moved TO', () => {
  it('refuses an admin raising an admin-level rule to owner, before reading the row', async () => {
    await expect(updateRule(COMPANY, 'rule-1', { approverRole: 'owner' }, actor('admin')))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('still refuses on the stored role when the update does not touch it', async () => {
    sqlMock.mockResolvedValueOnce([ruleRow({ approver_role: 'owner' })]);
    await expect(updateRule(COMPANY, 'rule-1', { isActive: false }, actor('admin')))
      .rejects.toBeInstanceOf(ApprovalRuleAuthorityError);
  });

  it('lets an owner move a rule between ranks they hold', async () => {
    sqlMock
      .mockResolvedValueOnce([ruleRow({ approver_role: 'owner' })])
      .mockResolvedValueOnce([ruleRow({ approver_role: 'manager' })]);
    await expect(updateRule(COMPANY, 'rule-1', { approverRole: 'manager' }, actor('owner')))
      .resolves.toMatchObject({ approverRole: 'manager' });
  });
});

describe('requestApproval — the governing rule is resolved, not named', () => {
  /** checkApproval runs two statements: the pending lookup, then the rule list. */
  const resolves = (rules: unknown[]) => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce(rules);
  };

  it('stores the strictest matching rule, not the laxest one', async () => {
    resolves([ruleRow({ id: 'lax', approver_role: 'viewer' }), ruleRow({ id: 'strict', approver_role: 'owner' })]);
    sqlMock.mockResolvedValueOnce([{
      id: 'req-1', rule_id: 'strict', document_type: 'payment', document_id: 'doc-1',
      amount: 100, status: 'pending', requested_by: 'user-1', requested_at: '2026-01-01',
      decided_by: null, decided_at: null, decision_notes: null, document_reference: null,
    }]);
    const request = await requestApproval(COMPANY, {
      documentType: 'payment', documentId: 'doc-1', amount: 100, requestedBy: 'user-1',
    });
    expect(request.ruleId).toBe('strict');
  });

  it('refuses when no active rule of this company governs the document', async () => {
    resolves([]);
    await expect(requestApproval(COMPANY, {
      documentType: 'payment', documentId: 'doc-1', amount: 100, requestedBy: 'user-1',
    })).rejects.toBeInstanceOf(ApprovalNotRequiredError);
    // The pending lookup and the rule list, and nothing else: no INSERT ran.
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('returns the pending request a document already has rather than raising a second', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{
      id: 'req-existing', rule_id: 'strict', document_type: 'payment', document_id: 'doc-1',
      amount: 100, status: 'pending', requested_by: 'someone-else', requested_at: '2026-01-01',
      decided_by: null, decided_at: null, decision_notes: null, document_reference: null,
    }]);
    const request = await requestApproval(COMPANY, {
      documentType: 'payment', documentId: 'doc-1', amount: 100, requestedBy: 'user-1',
    });
    expect(request.id).toBe('req-existing');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
