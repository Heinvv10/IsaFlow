/**
 * Unit tests for auditService.logAdminAction — pentest M6 (audit fail-open).
 *
 * A failed audit write must throw a distinct CriticalAuditError AND flag the
 * request context (als) so the platform-admin middleware rolls the whole
 * transaction back. That is now the DEFAULT for every action: only a name in
 * BEST_EFFORT_ACTIONS may commit its mutation unaudited.
 *
 * DB + als are mocked via vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';

const { sqlMock, ctx } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const ctx: { criticalAuditFailed?: boolean } = {};
  return { sqlMock, ctx };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  // The INSERT now runs inside its own savepoint so its failure cannot abort
  // the request transaction. Outside a request tx withSavepoint just runs fn,
  // which is what the real implementation does too.
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ctx } }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  logAdminAction,
  CriticalAuditError,
  BEST_EFFORT_ACTIONS,
} from '@/modules/admin/services/auditService';

const ADMIN = 'admin-user-1';
const IP = '203.0.113.1';

function ok() { sqlMock.mockImplementation(() => Promise.resolve([])); }
function fail() { sqlMock.mockImplementation(() => { throw new Error('db write failed'); }); }
function reset() { delete ctx.criticalAuditFailed; }

describe('logAdminAction — happy path', () => {
  it('writes the audit row and does not throw or flag', async () => {
    reset(); ok();
    await expect(
      logAdminAction(ADMIN, 'company.suspend', 'company', 'c1', { reason: 'x' }, IP)
    ).resolves.toBeUndefined();
    expect(ctx.criticalAuditFailed).toBeUndefined();
  });
});

describe('logAdminAction — audit write fails', () => {
  it('throws CriticalAuditError (distinct type, not a generic Error)', async () => {
    reset(); fail();
    await expect(
      logAdminAction(ADMIN, 'company.suspend', 'company', 'c1', null, IP)
    ).rejects.toBeInstanceOf(CriticalAuditError);
  });

  it('sets criticalAuditFailed on the request context (drives middleware rollback)', async () => {
    reset(); fail();
    await expect(
      logAdminAction(ADMIN, 'user.reset_password', 'user', 'u1', null, IP)
    ).rejects.toThrow();
    expect(ctx.criticalAuditFailed).toBe(true);
  });

  it('fails closed for every action, including the ones the old allow-list missed', async () => {
    // The first three were on the old CRITICAL_ACTIONS allow-list. The rest
    // were NOT, and each of them repriced billing, granted free paid service or
    // granted access to a tenant's books — the omissions that made an
    // allow-list the wrong shape. An unknown name fails closed too.
    for (const action of [
      'company.impersonate', 'company.delete', 'user.suspend',
      'flow.bundle.update', 'invoice.create', 'trial.extend',
      'company.extend_trial', 'user.add_to_company', 'user.remove_from_company',
      'user.activate', 'company.note_added',
    ]) {
      reset(); fail();
      await expect(
        logAdminAction(ADMIN, action, 'x', 'id', null, IP)
      ).rejects.toBeInstanceOf(CriticalAuditError);
      expect(ctx.criticalAuditFailed).toBe(true);
    }
  });
});

describe('logAdminAction — BEST_EFFORT action, audit write fails', () => {
  it('does NOT throw and does NOT flag the context', async () => {
    // The set is empty today, so exercise the branch through a temporary entry
    // rather than asserting nothing. This is the ONLY escape from fail-closed.
    BEST_EFFORT_ACTIONS.add('company.note_added');
    try {
      reset(); fail();
      await expect(
        logAdminAction(ADMIN, 'company.note_added', 'company', 'c1', null, IP)
      ).resolves.toBeUndefined();
      expect(ctx.criticalAuditFailed).toBeUndefined();
    } finally {
      BEST_EFFORT_ACTIONS.delete('company.note_added');
    }
  });
});
