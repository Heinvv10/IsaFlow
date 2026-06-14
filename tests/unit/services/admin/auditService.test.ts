/**
 * Unit tests for auditService.logAdminAction — pentest M6 (audit fail-open).
 *
 * A failed CRITICAL_ACTIONS audit write must throw a distinct CriticalAuditError
 * AND flag the request context (als) so the platform-admin middleware rolls the
 * whole transaction back. Non-critical actions stay fail-open.
 *
 * DB + als are mocked via vi.mock.
 */
import { describe, it, expect, vi } from 'vitest';

const { sqlMock, ctx } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  const ctx: { criticalAuditFailed?: boolean } = {};
  return { sqlMock, ctx };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ctx } }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { logAdminAction, CriticalAuditError } from '@/modules/admin/services/auditService';

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

describe('logAdminAction — CRITICAL action, audit write fails', () => {
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

  it('treats user.impersonate / company.delete / impersonation_start as critical', async () => {
    for (const action of ['user.impersonate', 'company.delete', 'impersonation_start']) {
      reset(); fail();
      await expect(
        logAdminAction(ADMIN, action, 'x', 'id', null, IP)
      ).rejects.toBeInstanceOf(CriticalAuditError);
      expect(ctx.criticalAuditFailed).toBe(true);
    }
  });
});

describe('logAdminAction — NON-critical action, audit write fails (fail-open)', () => {
  it('does NOT throw and does NOT flag the context', async () => {
    reset(); fail();
    await expect(
      logAdminAction(ADMIN, 'company.extend_trial', 'company', 'c1', { days: 7 }, IP)
    ).resolves.toBeUndefined();
    expect(ctx.criticalAuditFailed).toBeUndefined();
  });

  it('does not flag for an unknown/low-risk action', async () => {
    reset(); fail();
    await expect(
      logAdminAction(ADMIN, 'company.note_added', 'company', 'c1', null, IP)
    ).resolves.toBeUndefined();
    expect(ctx.criticalAuditFailed).toBeUndefined();
  });
});
