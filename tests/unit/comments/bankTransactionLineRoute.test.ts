/** GET /api/accounting/bank-transaction-line: a missing line says "Bank line not found" once (the helper adds the suffix). */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/modules/accounting/services/bank/bankTxSingleLine', () => ({ getBankTransactionById: vi.fn(async () => null) }));
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../pages/api/accounting/bank-transaction-line';

describe('bank-transaction-line', () => {
  it('404 with the exact message', async () => {
    const out = { status: 0, body: undefined as { error?: { message?: string } } | undefined };
    const res = { status(s: number) { out.status = s; return res; }, json(b: typeof out.body) { out.body = b; return res; }, setHeader: vi.fn() };
    await (handler as H)({ method: 'GET', companyId: 'c', query: { id: '11111111-1111-4111-8111-111111111111' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
    expect(out.status).toBe(404);
    expect(out.body?.error?.message).toBe('Bank line not found');
  });
});
