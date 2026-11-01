import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankRulesService', () => ({
  getRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  toggleRule: vi.fn(),
  validateCreateRuleTargets: vi.fn(),
  validateUpdateRuleTargets: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankRuleChangeControl', () => ({
  rulePostsMoney: vi.fn(),
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
  toggleRule,
  updateRule,
  validateUpdateRuleTargets,
} from '@/modules/accounting/services/bank/bankRulesService';
import { disableBankRuleTool, updateBankRuleTool } from '@/lib/mcp/tools/writeBankRules';
import { rulePostsMoney } from '@/modules/accounting/services/bank/bankRuleChangeControl';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { BankCategorisationRule } from '@/modules/accounting/types/bank.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const RULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = { idempotency_key: 'bank-rule-reenable-scope-1' };

const ctx = (): McpToolContext => ({
  userId: USER,
  companyId: COMPANY,
  companyRole: 'owner',
  scopes: ['write:bank-tx'],
  tokenJti: 'jti',
  oauthAppId: null,
});

const rule = (autoCreateEntry: boolean, isActive = true): BankCategorisationRule => ({
  id: RULE_ID,
  ruleName: 'Bank charges',
  matchField: 'description',
  matchType: 'contains',
  matchPattern: 'BANK CHARGE',
  priority: 100,
  isActive,
  autoCreateEntry,
  vatCode: 'none',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as BankCategorisationRule);

const scopeError = (result: McpToolResult): { code: string; message: string } => {
  expect(result.isError).toBe(true);
  const body = JSON.parse(result.content[0]!.text) as {
    success: boolean;
    error: { code: string; message: string };
  };
  expect(body).toMatchObject({ success: false, error: { code: 'INSUFFICIENT_SCOPE' } });
  return body.error;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rulePostsMoney).mockResolvedValue(false);
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
});

describe('inactive bank-rule posting scope', () => {
  it('surfaces live target validation on a dry run', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(false)]);
    vi.mocked(validateUpdateRuleTargets).mockRejectedValue(
      new Error('Rule "Bank charges" posts to the accounts payable control account'),
    );

    const result = await updateBankRuleTool.handler(
      { rule_id: RULE_ID, gl_account_id: RULE_ID, dry_run: true, ...KEY },
      ctx(),
    );

    expect(result.content[0]!.text).toMatch(/accounts payable control account/);
    expect(validateUpdateRuleTargets).toHaveBeenCalledOnce();
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('allows editing an inactive auto-create rule without write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true, false)]);
    vi.mocked(updateRule).mockImplementation(async (_company, _id, _input, _user, guard) => {
      await guard?.({ auto_create_entry: true, is_active: false }, false);
      return rule(true, false);
    });

    const result = await updateBankRuleTool.handler(
      { rule_id: RULE_ID, rule_name: 'Renamed while inactive', ...KEY },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(updateRule).toHaveBeenCalledOnce();
  });

  it('refuses reactivating an auto-posting rule without write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true, false)]);

    const result = await disableBankRuleTool.handler(
      { rule_id: RULE_ID, enable: true, ...KEY },
      ctx(),
    );

    expect(scopeError(result).message).toMatch(/post to ledger/i);
    expect(toggleRule).not.toHaveBeenCalled();
  });

  it('rechecks auto-create after the pre-read', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(false, false)]);
    vi.mocked(toggleRule).mockImplementation(async (_company, _id, _active, _user, guard) => {
      await guard?.({ auto_create_entry: true, is_active: true });
      return rule(true, true);
    });

    const result = await disableBankRuleTool.handler(
      { rule_id: RULE_ID, enable: true, ...KEY },
      ctx(),
    );

    expect(scopeError(result).message).toMatch(/post to ledger/i);
    expect(toggleRule).toHaveBeenCalledOnce();
  });

  it('rechecks company auto-post after the pre-read', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(false, false)]);
    vi.mocked(toggleRule).mockImplementation(async (_company, _id, _active, _user, guard) => {
      await guard?.({ auto_create_entry: false, is_active: true }, true);
      return rule(false, true);
    });

    const result = await disableBankRuleTool.handler(
      { rule_id: RULE_ID, enable: true, ...KEY },
      ctx(),
    );

    expect(scopeError(result).message).toMatch(/write:post/);
    expect(toggleRule).toHaveBeenCalledOnce();
  });
});
