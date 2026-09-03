/**
 * The two consumers of getBankAccountsStatus, and what each one asks for.
 *
 * GET /api/accounting/bank-accounts serves picker screens as well as the bank
 * accounts list, so it stays active-only unless the caller passes
 * ?include_inactive=true. The MCP bank_accounts_status tool always opts in: an
 * agent asking for bank account status is asking about money, not choosing an
 * account to code against, and a deactivated account still holds a balance and
 * an unreconciled backlog.
 *
 * All DB calls and the status service are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getBankAccountsStatusMock = vi.fn(async () => [
  { id: 'acct-1', accountCode: '1110', accountName: 'Bank - Primary', isActive: false, balance: 6550 },
]);

vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({
  getBankAccountsStatus: (...a: unknown[]) => getBankAccountsStatusMock(...(a as [])),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import bankAccountsHandler from '../../../pages/api/accounting/bank-accounts';
import { bankAccountsStatusTool } from '@/lib/mcp/tools/bank';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

function mockReqRes(query: Record<string, string> = {}) {
  const req = { method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end(payload?: unknown) { this.sent = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

const callHandler = bankAccountsHandler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>;

beforeEach(() => vi.clearAllMocks());

describe('GET /api/accounting/bank-accounts', () => {
  it('is active-only by default, so picker screens cannot regress', async () => {
    const { req, res } = mockReqRes();
    await callHandler(req, res);

    expect(getBankAccountsStatusMock).toHaveBeenCalledWith(COMPANY, { includeInactive: false });
  });

  it('opts in on ?include_inactive=true', async () => {
    const { req, res } = mockReqRes({ include_inactive: 'true' });
    await callHandler(req, res);

    expect(getBankAccountsStatusMock).toHaveBeenCalledWith(COMPANY, { includeInactive: true });
  });

  it('treats any other value as off — only the exact string opts in', async () => {
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      vi.clearAllMocks();
      const { req, res } = mockReqRes({ include_inactive: v });
      await callHandler(req, res);
      expect(getBankAccountsStatusMock).toHaveBeenCalledWith(COMPANY, { includeInactive: false });
    }
  });
});

describe('MCP bank_accounts_status tool', () => {
  it('asks for inactive accounts too, because it is a money question', async () => {
    await bankAccountsStatusTool.handler({}, { companyId: COMPANY } as never);

    expect(getBankAccountsStatusMock).toHaveBeenCalledWith(COMPANY, { includeInactive: true });
  });

  it('returns rows unchanged apart from carrying isActive, so the response shape is additive', async () => {
    const result = await bankAccountsStatusTool.handler({}, { companyId: COMPANY } as never);
    const rows = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isActive: false, balance: 6550, accountCode: '1110' });
  });

  it('tells the agent inactive accounts can appear and how they are labelled', () => {
    expect(bankAccountsStatusTool.description).toMatch(/inactive/i);
    expect(bankAccountsStatusTool.description).toMatch(/isActive/);
    // "All active bank accounts" was a lie once the tool opted in.
    expect(bankAccountsStatusTool.description).not.toMatch(/^All active bank accounts/);
  });
});
