/**
 * Unit tests for the group (parent) assignment path in
 * PUT /api/accounting/bank-accounts.
 *
 * Contract:
 *   1. `parentAccountId` key present + non-null → assignParent validates:
 *      self-parent, parent must be a bank account in the same company,
 *      parent must not itself be a sub-account (two-level only), the account
 *      being grouped must not be an umbrella, and the parent must not carry
 *      its own bank transactions (it would vanish behind the leaf-only filter).
 *   2. `parentAccountId: null` clears the parent (explicit-null semantics —
 *      unlike the COALESCE fields, where null preserves).
 *   3. Key absent → parent untouched, only the COALESCE UPDATE runs.
 *   4. Every assignParent query is scoped by company_id (multi-tenant rule).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
  withWriteAccess: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success:          vi.fn(),
    badRequest:       vi.fn(),
    methodNotAllowed: vi.fn(),
    validationError:  vi.fn(),
  },
}));

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import { apiResponse } from '@/lib/apiResponse';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ alias resolution differs in test runner
import handler from '../../../../pages/api/accounting/bank-accounts';

const COMPANY_ID = '11111111-1111-4111-9111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-9222-222222222222';
const PARENT_ID  = '33333333-3333-4333-9333-333333333333';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return {
    method: 'PUT',
    body,
    companyId: COMPANY_ID,
    user: { id: 'user-1', claims: {} },
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

/** SQL text of the nth sql`` call (template strings joined). */
function sqlText(n: number): string {
  return (sqlMock.mock.calls[n]![0] as string[]).join('?');
}

const PARENT_OK = { id: PARENT_ID, parent_account_id: null, account_subtype: 'bank', parent_subtype: null };

describe('PUT /api/accounting/bank-accounts — parentAccountId (group assignment)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock.mockResolvedValue([]); // default: empty result set
  });

  it('rejects self-parenting without touching the DB', async () => {
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: ACCOUNT_ID }), makeRes());
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      expect.anything(), 'An account cannot be its own group');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('rejects a parent that is not a bank account in this company', async () => {
    sqlMock.mockResolvedValueOnce([]); // parent lookup → not found
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      expect.anything(), 'Group must be a bank account in this company');
  });

  it('rejects a parent that is itself a sub-account (two-level only)', async () => {
    sqlMock.mockResolvedValueOnce([{ ...PARENT_OK, parent_subtype: 'bank' }]);
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      expect.anything(), 'Group account is already a sub-account of another group');
  });

  it('rejects grouping an account that is itself an umbrella', async () => {
    sqlMock
      .mockResolvedValueOnce([PARENT_OK]) // parent lookup OK
      .mockResolvedValueOnce([{ '?column?': 1 }]); // self has bank children
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      expect.anything(), 'This account is a group itself — move its sub-accounts first');
  });

  it('rejects a parent that has its own bank transactions', async () => {
    sqlMock
      .mockResolvedValueOnce([PARENT_OK]) // parent lookup OK
      .mockResolvedValueOnce([])          // self-children check clear
      .mockResolvedValueOnce([{ '?column?': 1 }]); // parent has transactions
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    expect(apiResponse.badRequest).toHaveBeenCalledWith(
      expect.anything(),
      'Group account has its own bank transactions — pick an account without transactions as the group');
  });

  it('assigns a valid parent then runs the COALESCE update', async () => {
    sqlMock
      .mockResolvedValueOnce([PARENT_OK]) // parent lookup OK
      .mockResolvedValueOnce([])          // self-children clear
      .mockResolvedValueOnce([])          // parent-transactions clear
      .mockResolvedValueOnce([])          // UPDATE parent
      .mockResolvedValueOnce([]);         // COALESCE UPDATE
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    expect(apiResponse.badRequest).not.toHaveBeenCalled();
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), { updated: true });
    expect(sqlMock).toHaveBeenCalledTimes(5);
    expect(sqlText(3)).toContain('UPDATE gl_accounts SET parent_account_id =');
  });

  it('explicit null clears the parent (no validation lookups)', async () => {
    sqlMock
      .mockResolvedValueOnce([])  // UPDATE parent → null
      .mockResolvedValueOnce([]); // COALESCE UPDATE
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: null }), makeRes());
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), { updated: true });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlText(0)).toContain('UPDATE gl_accounts SET parent_account_id =');
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(null);
  });

  it('leaves the parent untouched when the key is absent', async () => {
    sqlMock.mockResolvedValueOnce([]); // COALESCE UPDATE only
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, accountName: 'Renamed' }), makeRes());
    expect(apiResponse.success).toHaveBeenCalledWith(expect.anything(), { updated: true });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlText(0)).not.toContain('parent_account_id =');
  });

  it('rejects a non-UUID parentAccountId via Zod before any DB access', async () => {
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: 'not-a-uuid' }), makeRes());
    expect(apiResponse.validationError).toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('scopes every assignParent query by company_id (multi-tenant rule)', async () => {
    sqlMock
      .mockResolvedValueOnce([PARENT_OK])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await (handler as unknown as Handler)(
      makeReq({ id: ACCOUNT_ID, parentAccountId: PARENT_ID }), makeRes());
    for (let n = 0; n < 4; n++) {
      expect(sqlText(n)).toContain('company_id =');
      expect(sqlMock.mock.calls[n]!.slice(1)).toContain(COMPANY_ID);
    }
    // The grandparent-subtype subquery must be tenant-scoped too.
    expect(sqlText(0).match(/company_id =/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
