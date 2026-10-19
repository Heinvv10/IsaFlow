/**
 * G-06: a year closed and reversed too often, or whose close has an unreadable reversal chain, is refused
 * with a typed result BEFORE any write. The REST route answers 409 and the MCP tool a tool error that
 * names the closing journal, tells the agent not to retry, and says nothing was posted. Neither is a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { closeFiscalYear } = vi.hoisted(() => ({ closeFiscalYear: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/yearEndService', () => ({ closeFiscalYear, listFiscalYears: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withRole: () => (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h, markFlowNoOp: vi.fn() }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: vi.fn() }));
vi.mock('@/lib/apiJournalDate', () => ({
  JOURNAL_DATE_REFUSED: Symbol('refused'),
  withJournalDateRefusal: async (_res: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/auth/impersonationGuard', () => ({
  assertNotImpersonating: vi.fn(), respondIfImpersonationForbidden: () => false,
}));

import yearEnd from '../../../pages/api/accounting/year-end';
import { yearEndCloseTool } from '@/lib/mcp/tools/writeFiscalPeriods';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:reports', 'write:journals', 'write:post'], tokenJti: 'j', oauthAppId: null,
};

const REFUSALS = [
  { error: 'too_many_recloses', code: 'YEAR_END_TOO_MANY_RECLOSES', entryNumber: 'YE-2027' },
  { error: 'closing_chain_unreadable', code: 'YEAR_END_CLOSE_CHAIN_TOO_LONG', entryNumber: 'YE-2027-R3' },
] as const;

async function post(): Promise<{ status: number; body: unknown }> {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;
  await yearEnd({ method: 'POST', body: { yearLabel: '2027', action: 'close' }, companyId: ctx.companyId, user: { id: 'u' } } as unknown as NextApiRequest, res);
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe.each(REFUSALS)('close refusal $error', (refusal) => {
  it('is a 409 on the REST route, naming the closing journal, not a 500', async () => {
    closeFiscalYear.mockResolvedValue(refusal);
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain(refusal.entryNumber);
    expect(JSON.stringify(body)).toContain(refusal.code);
    expect(JSON.stringify(body)).toMatch(/Nothing was posted/);
  });

  it('is a tool error on the MCP tool: names the journal, nothing posted, do not retry', async () => {
    closeFiscalYear.mockResolvedValue(refusal);
    const res = await yearEndCloseTool.handler({ fiscal_year: 2027, idempotency_key: 'k-1' }, ctx);
    const text = res.content[0]!.text;
    expect(res.isError).toBe(true);
    expect(text).toContain(refusal.entryNumber);
    expect(text.startsWith(refusal.code)).toBe(true);
    expect(text).toMatch(/Nothing was posted/);
    expect(text).toMatch(/do not retry/);
  });
});
