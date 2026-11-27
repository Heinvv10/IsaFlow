/**
 * Round 36 (B36-1): a COMMIT whose promise rejects with a value that cannot be read (hostileValues.ts) is CommitUnconfirmedError, as a
 * plain Error is: the batch may have landed, so the runner lists it commit unconfirmed and stops there; never "failed, nothing written".
 * (A COMMIT the driver rejects without sending it is, to the session, the same rejection: covered with every ROLLBACK answer in
 * sageToolSessionRollback.test.ts.) A query of the request that rejects with one is a plain failure, never a throw out of the session's
 * own handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { hostileValues } from './hostileValues';

const registry = vi.hoisted(() => ({ call: vi.fn<(name: string, args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>>() }));
vi.mock('@/lib/mcp/toolIndex', () => ({ mcpRegistry: { listTools: () => [{ name: 'w', write: true }], call: registry.call } }));
vi.mock('@/lib/auth/companyMembership', () => ({ getCompanyMembership: async () => ({ rows: [{ account_user_id: 'u1', role: 'owner' }] }) }));
vi.mock('@/lib/auth/userAccountStatus', () => ({ isActiveUserAccount: () => true }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (_ctx: unknown, fn: () => unknown) => fn(), drainAfterCommit: () => undefined, settleAfterRollback: () => undefined }));
vi.mock('@/lib/rollbackFailed', () => {
  // A test can make rollbackError itself throw (globalThis.__sageRollbackThrows): a contract break the session must survive (round 37).
  const rollbackError = async (c: { query: (t: string) => Promise<unknown> }) => {
    const t = (globalThis as { __sageRollbackThrows?: () => unknown }).__sageRollbackThrows;
    if (t) throw t();
    return c.query('ROLLBACK').then(() => null, (e: unknown) => e as Error);
  };
  return { rollbackError, rollbackFailed: async (c: { query: (t: string) => Promise<unknown> }) => (await rollbackError(c)) !== null };
});

import { EventEmitter } from 'node:events';
import { CommitUnconfirmedError, withToolSession } from '@/modules/accounting/services/sage-migration/sageToolSession';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const clientWhose = (fail: (text: string) => unknown | undefined) => Object.assign(new EventEmitter(), {
  query: async (text: string) => { const v = fail(text); if (v !== undefined) throw v; return { rows: [] }; },
  release: vi.fn(),
});
beforeEach(() => { registry.call.mockReset(); });

describe('B36-1: a COMMIT that rejects with a value that cannot be read', () => {
  for (const [what, make] of [...hostileValues, ['a plain Error (the control)', () => new Error('injected: plain')] as [string, () => unknown]]) {
    it(`${what}: CommitUnconfirmedError (unconfirmed, never failed), with the tool's answer kept`, async () => {
      registry.call.mockResolvedValueOnce(ok('{"created":1}'));
      const client = clientWhose((t) => (t === 'COMMIT' ? make() : undefined));
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CommitUnconfirmedError);
      expect((err as CommitUnconfirmedError).result).toMatchObject({ body: { created: 1 } });
    });
  }
});

describe('B36-1: a query of the request that rejects with one', () => {
  for (const [what, make] of hostileValues) {
    it(`${what}: the request fails as a plain Error, rolled back, no COMMIT, no throw from the session's handlers`, async () => {
      const sent: string[] = [];
      const client = Object.assign(new EventEmitter(), {
        query: async (text: string) => { sent.push(text); if (text === 'SET LOCAL ROLE app_user') throw make(); return { rows: [] }; }, // through the session's watched query
        release: vi.fn(),
      });
      const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(() => String(err)).not.toThrow();
      expect(sent).not.toContain('COMMIT');
    });
  }
});

describe('round 37: a rollbackError that throws (a broken contract) cannot replace the outcome', () => {
  for (const [what, make] of [['a plain Error', () => new Error('rollback blew up')] as [string, () => unknown], ...hostileValues]) {
    it(`it throws ${what}: still CommitUnconfirmedError, and the connection destroyed`, async () => {
      (globalThis as { __sageRollbackThrows?: () => unknown }).__sageRollbackThrows = make;
      try {
        registry.call.mockResolvedValueOnce(ok('{"created":1}'));
        const client = clientWhose((t) => (t === 'COMMIT' ? new Error('COMMIT did not answer') : undefined));
        const err = await withToolSession({ connect: async () => client } as never, 'c1', 'u1', true, (s) => s.call('w', { idempotency_key: 'k' })).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(CommitUnconfirmedError);
        expect(client.release).toHaveBeenCalledWith(true);
      } finally { (globalThis as { __sageRollbackThrows?: unknown }).__sageRollbackThrows = undefined; }
    });
  }
});
