/**
 * Bank-rule automatic posting is a deferred ledger write: creating or keeping
 * the rule does not post now, but its next match can. These tests pin the
 * per-call write:post gate, including state-dependent updates and dry runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  createRule,
  getRules,
  toggleRule,
  updateRule,
} from '@/modules/accounting/services/bank/bankRulesService';
import {
  createBankRuleTool,
  disableBankRuleTool,
  updateBankRuleTool,
} from '@/lib/mcp/tools/writeBankRules';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { BankCategorisationRule } from '@/modules/accounting/types/bank.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const RULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = { idempotency_key: 'bank-rule-scope-1' };
const CREATE_ARGS = {
  rule_name: 'Bank charges',
  match_field: 'description',
  match_type: 'contains',
  match_pattern: 'BANK CHARGE',
  ...KEY,
};

function ctx(scopes: string[]): McpToolContext {
  return {
    userId: USER,
    companyId: COMPANY,
    companyRole: 'owner',
    scopes,
    tokenJti: 'jti',
    oauthAppId: null,
  };
}

function rule(autoCreateEntry: boolean, isActive = true): BankCategorisationRule {
  return {
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
  } as BankCategorisationRule;
}

function errorText(result: McpToolResult): string {
  expect(result.isError).toBe(true);
  return result.content[0]!.text;
}

function resultJson(result: McpToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create_bank_rule automatic-posting scope', () => {
  it('refuses true without write:post and writes nothing', async () => {
    const result = await createBankRuleTool.handler(
      { ...CREATE_ARGS, auto_create_entry: true },
      ctx(['write:bank-tx']),
    );

    expect(errorText(result)).toMatch(/post to ledger/i);
    expect(errorText(result)).toContain('auto_create_entry=false');
    expect(createRule).not.toHaveBeenCalled();
  });

  it('allows true with write:post and preserves approval enforcement', async () => {
    vi.mocked(createRule).mockResolvedValue({
      status: 'pending_approval', changeId: 'change-1',
    });

    const result = await createBankRuleTool.handler(
      { ...CREATE_ARGS, auto_create_entry: true },
      ctx(['write:bank-tx', 'write:post']),
    );

    expect(resultJson(result)).toMatchObject({
      status: 'pending_approval', change_id: 'change-1',
    });
    expect(vi.mocked(createRule).mock.calls[0]![1].autoCreateEntry).toBe(true);
  });

  it('allows false without write:post', async () => {
    vi.mocked(createRule).mockResolvedValue(rule(false));

    await createBankRuleTool.handler(
      { ...CREATE_ARGS, auto_create_entry: false },
      ctx(['write:bank-tx']),
    );

    expect(createRule).toHaveBeenCalledOnce();
    expect(vi.mocked(createRule).mock.calls[0]![1].autoCreateEntry).toBe(false);
  });

  it('has dry-run refusal parity and writes nothing on an allowed preview', async () => {
    const args = { ...CREATE_ARGS, auto_create_entry: true, dry_run: true };
    const refused = await createBankRuleTool.handler(args, ctx(['write:bank-tx']));
    expect(errorText(refused)).toMatch(/post to ledger/i);

    const preview = await createBankRuleTool.handler(
      args,
      ctx(['write:bank-tx', 'write:post']),
    );
    expect(resultJson(preview)).toMatchObject({ dry_run: true, auto_create_entry: true });
    expect(preview.wroteNothing).toBe(true);
    expect(createRule).not.toHaveBeenCalled();
  });
});

describe('update_bank_rule automatic-posting scope', () => {
  it('refuses setting true without write:post and writes nothing', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(false)]);

    const result = await updateBankRuleTool.handler(
      { rule_id: RULE_ID, auto_create_entry: true, ...KEY },
      ctx(['write:bank-tx']),
    );

    expect(errorText(result)).toMatch(/post to ledger/i);
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('refuses keeping stored true by omission without write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true)]);

    const result = await updateBankRuleTool.handler(
      { rule_id: RULE_ID, rule_name: 'Renamed', ...KEY },
      ctx(['write:bank-tx']),
    );

    expect(errorText(result)).toMatch(/post to ledger/i);
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('allows turning automatic posting off without write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true)]);
    vi.mocked(updateRule).mockResolvedValue(rule(false));

    await updateBankRuleTool.handler(
      { rule_id: RULE_ID, auto_create_entry: false, ...KEY },
      ctx(['write:bank-tx']),
    );

    expect(updateRule).toHaveBeenCalledOnce();
    expect(vi.mocked(updateRule).mock.calls[0]![2].autoCreateEntry).toBe(false);
  });

  it('allows setting or keeping true with write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true)]);
    vi.mocked(updateRule).mockResolvedValue(rule(true));

    await updateBankRuleTool.handler(
      { rule_id: RULE_ID, rule_name: 'Renamed', ...KEY },
      ctx(['write:bank-tx', 'write:post']),
    );

    expect(updateRule).toHaveBeenCalledOnce();
  });

  it('has keep-true dry-run parity and never updates on preview', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true)]);
    const args = { rule_id: RULE_ID, rule_name: 'Renamed', dry_run: true, ...KEY };

    const refused = await updateBankRuleTool.handler(args, ctx(['write:bank-tx']));
    expect(errorText(refused)).toMatch(/post to ledger/i);

    const preview = await updateBankRuleTool.handler(
      args,
      ctx(['write:bank-tx', 'write:post']),
    );
    expect(resultJson(preview)).toMatchObject({
      dry_run: true, rule_id: RULE_ID, auto_create_entry: true,
    });
    expect(preview.wroteNothing).toBe(true);
    expect(updateRule).not.toHaveBeenCalled();
  });
});

describe('disable_bank_rule automatic-posting scope', () => {
  it('refuses reactivating an auto-posting rule without write:post', async () => {
    vi.mocked(getRules).mockResolvedValue([rule(true, false)]);

    const result = await disableBankRuleTool.handler(
      { rule_id: RULE_ID, enable: true, ...KEY },
      ctx(['write:bank-tx']),
    );

    expect(errorText(result)).toMatch(/post to ledger/i);
    expect(toggleRule).not.toHaveBeenCalled();
  });
});
