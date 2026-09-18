/**
 * The bank rule's own auto-apply instruction (migration 676).
 *
 * A rule with `auto_create_entry` posts DR Accounts Payable / CR Bank and
 * creates the supplier payment with NO human in the loop, so it has to carry
 * the instruction the attended paths pass per call. The column shipped without
 * a writer: every rule read 'fifo' because that is the column default, and no
 * caller could ever choose 'none'.
 *
 * REFUSED, NEVER COERCED. The column has a CHECK constraint, so a typo that
 * reached it would raise 23514 mid-statement instead of a message the caller
 * can act on — and a typo that silently became 'fifo' would have an unattended
 * sweep apply cash the rule's author asked to leave on account.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), getPoolForTests: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  assertCustomerInCompany: vi.fn(async () => undefined),
  assertSupplierInCompany: vi.fn(async () => undefined),
}));

import { sql } from '@/lib/neon';
import { createRule, updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { parseRuleAutoApply } from '@/lib/mcp/tools/bankRuleShared';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const RULE = '33333333-3333-3333-3333-333333333333';

const ROW = {
  id: RULE, rule_name: 'Reload', match_field: 'description', match_type: 'contains',
  match_pattern: 'RELOAD', priority: 100, is_active: true, auto_create_entry: true,
  vat_code: 'none', created_at: '2026-09-18', updated_at: '2026-09-18',
};

const INPUT = {
  ruleName: 'Reload',
  matchField: 'description' as const,
  matchType: 'contains' as const,
  matchPattern: 'RELOAD',
};

function lastValues(): unknown[] {
  return mockSql.mock.calls.at(-1)!.slice(1);
}

function lastQuery(): string {
  return mockSql.mock.calls.at(-1)![0].join('?').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([ROW] as never);
});

describe('createRule — auto_apply', () => {
  it('writes the mode the caller chose', async () => {
    await createRule(COMPANY, { ...INPUT, autoApply: 'none' }, USER);
    expect(lastQuery()).toContain('auto_apply');
    // Two 'none' values now: vat_code and the mode.
    expect(lastValues().filter((v) => v === 'none')).toHaveLength(2);
  });

  it('leaves the column to its own default when the caller names nothing', async () => {
    await createRule(COMPANY, INPUT, USER);
    // Passed as undefined, so the column default ('fifo') stands rather than a
    // second copy of the default living in this service. The one 'none' in the
    // values is vat_code, which does default in this service.
    expect(lastValues().filter((v) => v === 'none')).toHaveLength(1);
    expect(lastValues()).toContain(undefined);
  });

  it('refuses a mode that is not one, before the INSERT', async () => {
    await expect(
      createRule(COMPANY, { ...INPUT, autoApply: 'oldest' as never }, USER),
    ).rejects.toThrow(/auto_apply must be one of: fifo, none/);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('updateRule — auto_apply', () => {
  it('changes the mode when named', async () => {
    await updateRule(COMPANY, RULE, { autoApply: 'none' });
    expect(lastQuery()).toContain('auto_apply = COALESCE(?, auto_apply)');
    expect(lastValues()).toContain('none');
  });

  it('refuses a mode that is not one', async () => {
    await expect(
      updateRule(COMPANY, RULE, { autoApply: 'fifo ' as never }),
    ).rejects.toThrow(/auto_apply must be one of/);
  });
});

describe('mapRuleRow — a rule written before the column existed', () => {
  it('reads NULL as the DEFAULT, not as "apply nothing"', async () => {
    // Reading it as 'none' would reproduce the state the default exists to
    // end: cash posted by a rule, against bills it never closes.
    mockSql.mockResolvedValue([{ ...ROW, auto_apply: null }] as never);
    const rule = await createRule(COMPANY, INPUT, USER);
    expect(rule.autoApply).toBe('fifo');
  });

  it('reads a stored mode back verbatim', async () => {
    mockSql.mockResolvedValue([{ ...ROW, auto_apply: 'none' }] as never);
    const rule = await createRule(COMPANY, INPUT, USER);
    expect(rule.autoApply).toBe('none');
  });
});

describe('parseRuleAutoApply — the MCP tools’ runtime gate', () => {
  it('passes the two modes and reports anything else as invalid', () => {
    expect(parseRuleAutoApply({ auto_apply: 'fifo' })).toBe('fifo');
    expect(parseRuleAutoApply({ auto_apply: 'none' })).toBe('none');
    expect(parseRuleAutoApply({})).toBeUndefined();
    expect(parseRuleAutoApply({ auto_apply: null })).toBeUndefined();
    for (const bad of ['FIFO', 'off', 'oldest', '', 7, {}]) {
      expect(parseRuleAutoApply({ auto_apply: bad })).toBe('invalid');
    }
  });
});
