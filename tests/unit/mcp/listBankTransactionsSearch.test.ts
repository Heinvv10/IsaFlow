/**
 * `description_contains` on list_bank_transactions.
 *
 * The service wraps the term in %…% for ILIKE and escapes nothing, so the
 * tool must escape LIKE metacharacters or "50%" silently becomes a wildcard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({
  getBankAccountsStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  getBankTransactions: vi.fn(),
}));

import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { escapeLikeLiteral, listBankTransactionsTool } from '@/lib/mcp/tools/bank';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:bank-tx'], tokenJti: 'j', oauthAppId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBankTransactions).mockResolvedValue({ transactions: [], total: 0, nextCursor: null } as never);
});

describe('escapeLikeLiteral', () => {
  it('escapes %, _ and backslash so the term is a literal substring', () => {
    expect(escapeLikeLiteral('50% off_x\\y')).toBe('50\\% off\\_x\\\\y');
  });
  it('passes undefined through', () => {
    expect(escapeLikeLiteral(undefined)).toBeUndefined();
  });
});

describe('list_bank_transactions description_contains', () => {
  it('reaches the service as the escaped `search` filter', async () => {
    await listBankTransactionsTool.handler({ description_contains: 'MAKRO 100%' }, ctx);
    const filters = vi.mocked(getBankTransactions).mock.calls[0]![1]!;
    expect(filters.search).toBe('MAKRO 100\\%');
  });

  it('is absent from the filters when not supplied', async () => {
    await listBankTransactionsTool.handler({}, ctx);
    const filters = vi.mocked(getBankTransactions).mock.calls[0]![1]!;
    expect(filters.search).toBeUndefined();
  });

  it('is declared in the schema and documented as literal', () => {
    const props = listBankTransactionsTool.inputSchema.properties as Record<string, unknown>;
    expect(props.description_contains).toBeDefined();
    expect(listBankTransactionsTool.description).toContain('not wildcards');
  });
});
