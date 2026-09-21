/**
 * K-043 round-4 review, MEDIUM-2: among rules matching the same document,
 * `checkApproval` returned the FIRST one the scan produced. `priority` is
 * INTEGER DEFAULT 100 and no write path sets it, so every rule a company can
 * create ties and the winner was heap order — and the winner decides which
 * `approver_role` the decide path enforces.
 *
 * Two changes, both asserted here: the SQL orders deterministically, and the
 * STRICTEST match governs, so a laxer rule beside an owner-only one cannot
 * shadow it whichever way the tiebreak runs.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { checkApproval } from '@/modules/accounting/services/gl/approvalMatching';

const sqlMock = sql as unknown as MockedFunction<(strings: TemplateStringsArray) => Promise<unknown[]>>;

const rule = (id: string, approverRole: string, over: Record<string, unknown> = {}) => ({
  id, name: id, document_type: 'payment', condition_field: 'amount',
  condition_operator: 'any', condition_value: 0, approver_role: approverRole,
  is_active: true, priority: 100, created_at: '2026-01-01', ...over,
});

/** First call is the existing-pending-request lookup, second is the rule list. */
const withRules = (rows: unknown[]) => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
};

beforeEach(() => { vi.clearAllMocks(); });

describe('checkApproval — which of several matching rules governs', () => {
  it('picks the strictest when the lax rule comes first', async () => {
    withRules([rule('lax', 'viewer'), rule('strict', 'owner')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 500);
    expect(result.matchedRule?.id).toBe('strict');
  });

  it('picks the strictest when the strict rule comes first', async () => {
    withRules([rule('strict', 'owner'), rule('lax', 'viewer')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 500);
    expect(result.matchedRule?.id).toBe('strict');
  });

  it('ignores a stricter rule the amount does not actually match', async () => {
    withRules([
      rule('lax', 'manager'),
      rule('strict', 'owner', { condition_operator: 'greater_than', condition_value: 1000 }),
    ]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 500);
    expect(result.matchedRule?.id).toBe('lax');
  });

  it('keeps the first of two equally strict rules, so the SQL order is the tiebreak', async () => {
    withRules([rule('first', 'admin'), rule('second', 'admin')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 500);
    expect(result.matchedRule?.id).toBe('first');
  });

  it('lets a readable owner rule outrank a fail-closed unreadable one', async () => {
    withRules([rule('legacy', 'viewer', { condition_operator: 'less_than' }), rule('strict', 'owner')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 500);
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedRule?.id).toBe('strict');
  });

  it('orders the rule list by priority, created_at and id, not by heap order', async () => {
    withRules([rule('only', 'admin')]);
    await checkApproval('company-1', 'payment', 'doc-1', 500);
    const listQuery = sqlMock.mock.calls[1]![0].join(' ');
    expect(listQuery).toContain('ORDER BY priority ASC, created_at ASC, id ASC');
  });
});
