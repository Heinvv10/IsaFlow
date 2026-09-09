/**
 * K-108: checkApproval's switch had no default arm.
 *
 * condition_operator was written verbatim from the request body, so a rule
 * saved with 'gt' — which the switch cannot evaluate — left `matches` false and
 * the loop fell through to { requiresApproval: false }. A rule the UI showed as
 * "payments over R1,000" let R999,999 through with no log and no error.
 *
 * Migration 632 now constrains the column, but NOT VALID: rows written before it
 * can still carry an unreadable operator, so the default arm has to fail closed.
 * The constraint makes that state unreachable through the database, which is why
 * this is a unit test over a mocked driver rather than an integration one.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkApproval } from '@/modules/accounting/services/gl/approvalMatching';

const sqlMock = sql as unknown as MockedFunction<() => Promise<unknown[]>>;

const rule = (conditionOperator: string) => ({
  id: 'rule-1', name: 'Payments over 1000', document_type: 'payment',
  condition_field: 'amount', condition_operator: conditionOperator, condition_value: 1000,
  approver_role: 'admin', is_active: true, priority: 10, created_at: '2026-01-01',
});

/** First call is the existing-pending-request lookup, second is the rule list. */
const withRules = (rows: unknown[]) => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
};

describe('checkApproval — unrecognised condition_operator', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requires approval when the operator cannot be evaluated', async () => {
    withRules([rule('gt')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 999999);
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedRule?.conditionOperator).toBe('gt');
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognised condition_operator'),
      expect.objectContaining({ ruleId: 'rule-1', companyId: 'company-1', conditionOperator: 'gt' }),
      'accounting',
    );
  });

  it('requires approval even below the rule value — the threshold is unreadable', async () => {
    withRules([rule('gt')]);
    const result = await checkApproval('company-1', 'payment', 'doc-1', 1);
    expect(result.requiresApproval).toBe(true);
  });

  it('still evaluates the operators it does know', async () => {
    withRules([rule('greater_than')]);
    expect((await checkApproval('company-1', 'payment', 'doc-1', 999999)).requiresApproval).toBe(true);
    withRules([rule('greater_than')]);
    expect((await checkApproval('company-1', 'payment', 'doc-1', 999)).requiresApproval).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
