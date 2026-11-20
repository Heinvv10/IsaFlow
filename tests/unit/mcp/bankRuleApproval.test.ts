/**
 * #1656 round 5: the MCP bank-rule tools ask the token owner's Banking Approve for the same changes the app routes do: making an
 * auto-posting rule, editing where an existing one posts or what it matches (whether or not the call names auto_create_entry), and
 * turning one back on. The service is scripted to run the guard it is handed against a rule row, as the real write does under its lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(), createRule: vi.fn(), updateRule: vi.fn(), toggleRule: vi.fn(), validateCreateRuleTargets: vi.fn(), validateUpdateRuleTargets: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankRuleChangeControl', () => ({ rulePostsMoney: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ supplierBelongsToCompany: vi.fn(async () => true), customerBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => false) }));

import { createRule, getRules, toggleRule, updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import { createBankRuleTool, disableBankRuleTool, updateBankRuleTool } from '@/lib/mcp/tools/writeBankRules';
import type { McpToolContext } from '@/lib/mcp/types';
import type { BankCategorisationRule } from '@/modules/accounting/types/bank.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const RULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = { idempotency_key: 'k-1' };
const ctx = (): McpToolContext => ({ userId: 'u-1', companyId: COMPANY, companyRole: 'owner', scopes: ['write:bank-tx', 'write:post'], tokenJti: 'j', oauthAppId: null });

const rule = (over: Partial<BankCategorisationRule>): BankCategorisationRule => ({
  id: RULE_ID, ruleName: 'Fuel', matchField: 'description', matchType: 'contains', matchPattern: 'ENGEN', supplierId: SUP, priority: 100,
  isActive: true, autoCreateEntry: true, vatCode: 'none', autoApply: 'fifo', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
} as BankCategorisationRule);
const projection = (r: BankCategorisationRule) => ({
  match_field: r.matchField, match_type: r.matchType, match_pattern: r.matchPattern, gl_account_id: r.glAccountId ?? null, supplier_id: r.supplierId ?? null,
  client_id: r.clientId ?? null, description_template: r.descriptionTemplate ?? null, vat_code: r.vatCode, auto_apply: r.autoApply,
  auto_create_entry: r.autoCreateEntry, is_active: r.isActive,
});
/** The service double: runs the guard against (before, after) the way writeRuleChange does under the rule lock. */
function runGuard(before: BankCategorisationRule | null, patch: Record<string, unknown>) {
  return async (...a: unknown[]) => {
    const guard = a[a.length - 1] as ((after: unknown, posts: boolean, before: unknown) => Promise<void>) | undefined;
    const b = before ? projection(before) : null;
    await guard?.({ ...(b ?? { is_active: true }), ...patch }, false, b);
    return { ...(before ?? {}), status: 'applied' } as never;
  };
}
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

beforeEach(() => { vi.clearAllMocks(); vi.mocked(mayApprove).mockResolvedValue(false); });

describe('update_bank_rule without Banking Approve', () => {
  it('omitting auto_create_entry on an auto-posting rule and changing its match pattern is refused, whatever the flag says', async () => {
    const before = rule({});
    vi.mocked(getRules).mockResolvedValue([before]);
    vi.mocked(updateRule).mockImplementation(runGuard(before, { match_pattern: 'SHELL' }) as never);
    const r = await updateBankRuleTool.handler({ rule_id: RULE_ID, match_pattern: 'SHELL', ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/permission to approve auto-posting bank rules/);
    expect(mayApprove).toHaveBeenCalledWith(COMPANY, 'u-1', 'banking');
  });

  it('its dry run says the same, and writes nothing', async () => {
    vi.mocked(getRules).mockResolvedValue([rule({})]);
    const r = await updateBankRuleTool.handler({ rule_id: RULE_ID, match_pattern: 'SHELL', dry_run: true, ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('an allowed edit: a rule that does not auto-post is edited freely', async () => {
    const before = rule({ autoCreateEntry: false });
    vi.mocked(getRules).mockResolvedValue([before]);
    vi.mocked(updateRule).mockImplementation(runGuard(before, { match_pattern: 'SHELL' }) as never);
    const r = await updateBankRuleTool.handler({ rule_id: RULE_ID, match_pattern: 'SHELL', ...KEY }, ctx());
    expect(r.isError).toBeFalsy();
  });

  it('with Banking Approve the same edit goes through', async () => {
    vi.mocked(mayApprove).mockResolvedValue(true);
    const before = rule({});
    vi.mocked(getRules).mockResolvedValue([before]);
    vi.mocked(updateRule).mockImplementation(runGuard(before, { match_pattern: 'SHELL' }) as never);
    expect((await updateBankRuleTool.handler({ rule_id: RULE_ID, match_pattern: 'SHELL', ...KEY }, ctx())).isError).toBeFalsy();
  });
});

describe('disable_bank_rule (enable) and create_bank_rule without Banking Approve', () => {
  it('switching an auto-posting rule back ON is refused', async () => {
    const before = rule({ isActive: false });
    vi.mocked(getRules).mockResolvedValue([before]);
    vi.mocked(toggleRule).mockImplementation(runGuard(before, { is_active: true }) as never);
    const r = await disableBankRuleTool.handler({ rule_id: RULE_ID, enable: true, ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/permission to approve auto-posting bank rules/);
  });

  it('round 6: switching an auto-posting rule OFF is refused too (it changes which rule matches); a rule that does not post switches freely', async () => {
    const before = rule({});
    vi.mocked(getRules).mockResolvedValue([before]);
    vi.mocked(toggleRule).mockImplementation(runGuard(before, { is_active: false }) as never);
    expect((await disableBankRuleTool.handler({ rule_id: RULE_ID, enable: false, ...KEY }, ctx())).isError).toBe(true);
    const quiet = rule({ autoCreateEntry: false });
    vi.mocked(getRules).mockResolvedValue([quiet]);
    vi.mocked(toggleRule).mockImplementation(runGuard(quiet, { is_active: false }) as never);
    expect((await disableBankRuleTool.handler({ rule_id: RULE_ID, enable: false, ...KEY }, ctx())).isError).toBeFalsy();
  });

  it('creating an auto-posting rule is refused; creating a suggest-only one is not', async () => {
    const base = { rule_name: 'Fuel', match_field: 'description', match_type: 'contains', match_pattern: 'ENGEN', supplier_id: SUP, ...KEY };
    vi.mocked(createRule).mockImplementation(runGuard(null, { auto_create_entry: true }) as never);
    const refused = await createBankRuleTool.handler({ ...base, auto_create_entry: true }, ctx());
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/permission to approve auto-posting bank rules/);
    vi.mocked(createRule).mockImplementation(runGuard(null, { auto_create_entry: false }) as never);
    expect((await createBankRuleTool.handler({ ...base, auto_create_entry: false }, ctx())).isError).toBeFalsy();
  });
});
