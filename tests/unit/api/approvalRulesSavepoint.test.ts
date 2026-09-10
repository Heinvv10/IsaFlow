/**
 * K-043 round 3 (LOW-3): the route catches a 23514 from the operator CHECK and
 * answers 400. The statement that raised it has already put the `withAuth`
 * transaction into the aborted state, and withAuth COMMITs anything below a
 * 500 — PostgreSQL turns a COMMIT of an aborted transaction into a ROLLBACK,
 * so nothing is lost today only because each branch runs a single statement.
 * Add a write above that line and it would be discarded while the response
 * spoke only about the operator.
 *
 * The savepoint is what makes the catch honest rather than lucky, so these
 * assert the mutation runs inside one and that a failure unwinds it before the
 * 400 is written. Everything below the route is mocked: the subject is the
 * route's own error plumbing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const savepoints: string[] = [];
const rolledBack: string[] = [];

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: async (name: string, fn: () => Promise<unknown>) => {
    savepoints.push(name);
    try {
      return await fn();
    } catch (error) {
      rolledBack.push(name);
      throw error;
    }
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

const createRuleMock = vi.fn();
const updateRuleMock = vi.fn();
const deleteRuleMock = vi.fn();

vi.mock('@/modules/accounting/services/gl/approvalService', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/modules/accounting/services/gl/approvalService');
  return {
    ...actual,
    listRules: vi.fn(async () => []),
    createRule: (...a: unknown[]) => createRuleMock(...a),
    updateRule: (...a: unknown[]) => updateRuleMock(...a),
    deleteRule: (...a: unknown[]) => deleteRuleMock(...a),
  };
});

import handler from '../../../pages/api/accounting/approval-rules';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const RULE = 'bbbbbbbb-0000-0000-0000-000000000002';

function mockReqRes(method: string, body: Record<string, unknown>) {
  const req = {
    method, body, query: {}, companyId: COMPANY, companyRole: 'owner',
    user: { id: 'user-1', email: 'u@test.local' },
  } as unknown as NextApiRequest;
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

const call = handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<void>;

const checkViolation = () => Object.assign(new Error('violates check constraint'), { code: '23514' });

beforeEach(() => {
  savepoints.length = 0;
  rolledBack.length = 0;
  vi.clearAllMocks();
});

describe('every approval-rule mutation runs inside a savepoint', () => {
  it('wraps the create', async () => {
    createRuleMock.mockResolvedValue({ id: RULE });
    const { req, res } = mockReqRes('POST', { name: 'r', documentType: 'payment' });
    await call(req, res);
    expect(res.statusCode).toBe(200);
    expect(savepoints).toEqual(['approval_rule_write']);
  });

  it('wraps the update', async () => {
    updateRuleMock.mockResolvedValue({ id: RULE });
    const { req, res } = mockReqRes('PUT', { id: RULE, isActive: false });
    await call(req, res);
    expect(res.statusCode).toBe(200);
    expect(savepoints).toEqual(['approval_rule_write']);
  });

  it('wraps the delete', async () => {
    deleteRuleMock.mockResolvedValue(true);
    const { req, res } = mockReqRes('DELETE', { id: RULE });
    await call(req, res);
    expect(res.statusCode).toBe(200);
    expect(savepoints).toEqual(['approval_rule_write']);
  });
});

describe('a caught 23514 unwinds the savepoint before the 400 is written', () => {
  it('rolls back on create', async () => {
    createRuleMock.mockRejectedValue(checkViolation());
    const { req, res } = mockReqRes('POST', { name: 'r', documentType: 'payment' });
    await call(req, res);
    expect(rolledBack).toEqual(['approval_rule_write']);
    expect(res.statusCode).toBe(400);
  });

  it('rolls back on update', async () => {
    updateRuleMock.mockRejectedValue(checkViolation());
    const { req, res } = mockReqRes('PUT', { id: RULE, isActive: true });
    await call(req, res);
    expect(rolledBack).toEqual(['approval_rule_write']);
    expect(res.statusCode).toBe(400);
  });

  // An error the route does not map still has to leave the transaction usable
  // for withErrorHandler above it.
  it('rolls back an error it rethrows rather than maps', async () => {
    updateRuleMock.mockRejectedValue(new Error('connection reset'));
    const { req, res } = mockReqRes('PUT', { id: RULE, isActive: true });
    await expect(call(req, res)).rejects.toThrow('connection reset');
    expect(rolledBack).toEqual(['approval_rule_write']);
  });
});

/**
 * K-043 round 6 (LOW-2): `respondToRuleWriteError` is shared by POST, PUT and
 * DELETE, and its 23503 arm answered every one of them with "this rule has
 * approval requests recorded against it and cannot be deleted. Deactivate it
 * instead." A foreign-key violation on a CREATE or an UPDATE is a different
 * constraint entirely, and that sentence describes an operation the caller did
 * not perform.
 */
describe('the foreign-key arm answers only the DELETE that can raise it', () => {
  const fkViolation = () => Object.assign(
    new Error('violates foreign key constraint'), { code: '23503' });

  // clearAllMocks clears calls, not implementations: a rejection set here would
  // otherwise still be armed in the next describe.
  afterEach(() => {
    createRuleMock.mockReset(); updateRuleMock.mockReset(); deleteRuleMock.mockReset();
  });

  it('tells a delete that the rule is in use', async () => {
    deleteRuleMock.mockRejectedValue(fkViolation());
    const { req, res } = mockReqRes('DELETE', { id: RULE });
    await call(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/cannot be deleted/);
  });

  it('does not tell a create it cannot be deleted', async () => {
    createRuleMock.mockRejectedValue(fkViolation());
    const { req, res } = mockReqRes('POST', { name: 'r', documentType: 'payment' });
    await expect(call(req, res)).rejects.toMatchObject({ code: '23503' });
    expect(rolledBack).toEqual(['approval_rule_write']);
  });

  it('does not tell an update it cannot be deleted', async () => {
    updateRuleMock.mockRejectedValue(fkViolation());
    const { req, res } = mockReqRes('PUT', { id: RULE, isActive: false });
    await expect(call(req, res)).rejects.toMatchObject({ code: '23503' });
  });
});
