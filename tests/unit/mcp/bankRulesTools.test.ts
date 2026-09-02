/**
 * Bank-rule tools.
 *
 * These exist because a rule pointing at an account being retired would have
 * silently re-routed every future reload back to it, and no tool could see
 * rules at all. So the assertions that matter are about VISIBILITY and about
 * not writing to another tenant:
 *
 *  - `list_bank_rules` returns INACTIVE rules too. A disabled rule is still a
 *    thing an agent must see before it concludes an account is safe to retire.
 *  - filtering by `account_id` is the pre-retirement check, so it must find
 *    rules regardless of their active state.
 *  - `auto_posting_rules` counts only rules that will actually post.
 *  - every id a rule points at is checked against the token's company BEFORE
 *    the write; the services do not re-check the tenant.
 *  - `disable_bank_rule` reports a no-op as a no-op instead of claiming a change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  toggleRule: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany: vi.fn(),
  customerBelongsToCompany: vi.fn(),
}));

import {
  getRules,
  createRule,
  updateRule,
  toggleRule,
} from '@/modules/accounting/services/bank/bankRulesService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  supplierBelongsToCompany,
  customerBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { listBankRulesTool, getBankRuleTool } from '@/lib/mcp/tools/bankRules';
import {
  createBankRuleTool,
  updateBankRuleTool,
  disableBankRuleTool,
} from '@/lib/mcp/tools/writeBankRules';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { BankCategorisationRule } from '@/modules/accounting/types/bank.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RETIRED = '22222222-2222-4222-8222-222222222222';
const OTHER_ACC = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const KEY = { idempotency_key: 'k1' };
// Rule ids must be real UUIDs — every tool guards them before the ::UUID cast.
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const R3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['read:bank-tx', 'write:bank-tx'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}
function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

function rule(over: Partial<BankCategorisationRule> = {}): BankCategorisationRule {
  return {
    id: R1,
    ruleName: 'Reload Somerset W — Card No. 4765',
    matchField: 'description',
    matchType: 'contains',
    matchPattern: 'RELOAD SOMERSET',
    priority: 100,
    isActive: true,
    autoCreateEntry: true,
    vatCode: 'none',
    glAccountId: RETIRED,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as BankCategorisationRule;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
  vi.mocked(customerBelongsToCompany).mockResolvedValue(true);
});

describe('list_bank_rules', () => {
  it('is scoped to the token company and free', async () => {
    vi.mocked(getRules).mockResolvedValue([]);
    await listBankRulesTool.handler({}, ctx());
    expect(vi.mocked(getRules).mock.calls[0]![0]).toBe(COMPANY);
    expect(listBankRulesTool.write).toBe(false);
  });

  it('returns INACTIVE rules by default — a disabled rule is still visible', async () => {
    vi.mocked(getRules).mockResolvedValue([
      rule({ id: R1, isActive: true }),
      rule({ id: R2, isActive: false }),
    ]);
    const all = parseOk(await listBankRulesTool.handler({}, ctx()));
    expect((all.rules as { id: string }[]).map((r) => r.id)).toEqual([R1, R2]);

    const only = parseOk(await listBankRulesTool.handler({ active_only: true }, ctx()));
    expect((only.rules as { id: string }[]).map((r) => r.id)).toEqual([R1]);
  });

  it('finds every rule pointing at an account — the pre-retirement check', async () => {
    vi.mocked(getRules).mockResolvedValue([
      rule({ id: R1, glAccountId: RETIRED }),
      rule({ id: R2, glAccountId: OTHER_ACC }),
      // Inactive but still pointed at the account: must be found, because
      // re-enabling it later would resurrect the defect.
      rule({ id: R3, glAccountId: RETIRED, isActive: false }),
    ]);
    const r = parseOk(await listBankRulesTool.handler({ account_id: RETIRED }, ctx()));
    expect((r.rules as { id: string }[]).map((x) => x.id)).toEqual([R1, R3]);
    expect(r.total).toBe(2);
  });

  it('counts only rules that will actually POST', async () => {
    vi.mocked(getRules).mockResolvedValue([
      rule({ id: R1, isActive: true, autoCreateEntry: true }),
      rule({ id: R2, isActive: true, autoCreateEntry: false }),
      rule({ id: R3, isActive: false, autoCreateEntry: true }),
    ]);
    const r = parseOk(await listBankRulesTool.handler({}, ctx()));
    expect(r.total).toBe(3);
    expect(r.auto_posting_rules).toBe(1);
  });

  it('surfaces auto_create_entry and is_active on every row', async () => {
    vi.mocked(getRules).mockResolvedValue([rule()]);
    const r = parseOk(await listBankRulesTool.handler({}, ctx()));
    const row = (r.rules as Record<string, unknown>[])[0]!;
    expect(row.auto_create_entry).toBe(true);
    expect(row.is_active).toBe(true);
    expect(row.gl_account_id).toBe(RETIRED);
  });

  it('rejects a malformed account_id before querying', async () => {
    expect(errText(await listBankRulesTool.handler({ account_id: 'abc' }, ctx())))
      .toBe('invalid account_id');
    expect(getRules).not.toHaveBeenCalled();
  });
});

describe('get_bank_rule', () => {
  it('answers a rule from another company with the generic miss text', async () => {
    // getRules is company-scoped, so a foreign id simply is not in the list.
    vi.mocked(getRules).mockResolvedValue([rule({ id: R2 })]);
    expect(errText(await getBankRuleTool.handler(
      { rule_id: '99999999-9999-4999-8999-999999999999' }, ctx(),
    ))).toBe('Not found');
  });
});

describe('create_bank_rule', () => {
  const base = {
    rule_name: 'R', match_field: 'description', match_type: 'contains',
    match_pattern: 'X', ...KEY,
  };

  it('defaults auto_create_entry to FALSE — a rule must not silently post', async () => {
    vi.mocked(createRule).mockResolvedValue(rule({ autoCreateEntry: false }));
    await createBankRuleTool.handler(base, ctx());
    expect(vi.mocked(createRule).mock.calls[0]![1].autoCreateEntry).toBe(false);
  });

  it('checks EVERY referenced id against the token company before writing', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    expect(errText(await createBankRuleTool.handler(
      { ...base, gl_account_id: OTHER_ACC }, ctx(),
    ))).toBe('Not found');
    expect(createRule).not.toHaveBeenCalled();

    vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(false);
    expect(errText(await createBankRuleTool.handler(
      { ...base, supplier_id: SUPPLIER }, ctx(),
    ))).toBe('Not found');
    expect(createRule).not.toHaveBeenCalled();
  });

  it('refuses an unknown match_field / match_type without querying', async () => {
    expect(errText(await createBankRuleTool.handler(
      { ...base, match_field: 'memo' }, ctx(),
    ))).toContain('match_field must be one of');
    expect(errText(await createBankRuleTool.handler(
      { ...base, match_type: 'regex' }, ctx(),
    ))).toContain('match_type must be one of');
    expect(accountsBelongToCompany).not.toHaveBeenCalled();
  });

  it('refuses a non-integer priority rather than coercing it', async () => {
    expect(errText(await createBankRuleTool.handler({ ...base, priority: 1.5 }, ctx())))
      .toContain('whole number');
    expect(createRule).not.toHaveBeenCalled();
  });
});

describe('update_bank_rule', () => {
  it('re-points a rule at a live account — the migration fix', async () => {
    vi.mocked(getRules).mockResolvedValue([rule({ id: R1 })]);
    vi.mocked(updateRule).mockResolvedValue(rule({ id: R1, glAccountId: OTHER_ACC }));

    const r = parseOk(await updateBankRuleTool.handler(
      { rule_id: R1, gl_account_id: OTHER_ACC, ...KEY }, ctx(),
    ));
    expect(r.gl_account_id).toBe(OTHER_ACC);
    expect(vi.mocked(updateRule).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('will not re-point a rule at ANOTHER company account', async () => {
    vi.mocked(getRules).mockResolvedValue([rule({ id: R1 })]);
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    expect(errText(await updateBankRuleTool.handler(
      { rule_id: R1, gl_account_id: OTHER_ACC, ...KEY }, ctx(),
    ))).toBe('Not found');
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('answers an unowned rule with the generic miss text, before any write', async () => {
    vi.mocked(getRules).mockResolvedValue([]);
    expect(errText(await updateBankRuleTool.handler(
      { rule_id: R1, rule_name: 'X', ...KEY }, ctx(),
    ))).toBe('Not found');
    expect(updateRule).not.toHaveBeenCalled();
  });
});

describe('disable_bank_rule', () => {
  it('disables by default and reports the new state', async () => {
    vi.mocked(getRules).mockResolvedValue([rule({ id: R1, isActive: true })]);
    const r = parseOk(await disableBankRuleTool.handler({ rule_id: R1, ...KEY }, ctx()));
    expect(r.is_active).toBe(false);
    expect(r.already).toBe(false);
    expect(vi.mocked(toggleRule).mock.calls[0]!.slice(0, 3)).toEqual([COMPANY, R1, false]);
  });

  it('re-enables when asked', async () => {
    vi.mocked(getRules).mockResolvedValue([rule({ id: R1, isActive: false })]);
    const r = parseOk(await disableBankRuleTool.handler(
      { rule_id: R1, enable: true, ...KEY }, ctx(),
    ));
    expect(r.is_active).toBe(true);
    expect(vi.mocked(toggleRule).mock.calls[0]![2]).toBe(true);
  });

  it('reports a no-op AS a no-op and issues no write', async () => {
    // An agent retrying on the same key must not read "changed" when nothing did.
    vi.mocked(getRules).mockResolvedValue([rule({ id: R1, isActive: false })]);
    const r = parseOk(await disableBankRuleTool.handler({ rule_id: R1, ...KEY }, ctx()));
    expect(r.already).toBe(true);
    expect(toggleRule).not.toHaveBeenCalled();
  });
});
