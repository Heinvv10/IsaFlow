/**
 * Read-only visibility into a contested system-account role.
 *
 * `getSystemAccount` resolves a contest deterministically (type-consistent over
 * mistyped, then newer over older) and log.errors about it. That is the right
 * default for the many callers that must keep working, and it stays unchanged.
 *
 * But a caller that posts an entire year's profit in one entry cannot accept a
 * deterministic-but-arbitrary pick whose only record is a log line nobody
 * reads. `getSystemAccountCandidates` exposes the candidate set so such a
 * caller can refuse instead. It must not change resolution behaviour, and must
 * not issue its own query — it reads the same cache the resolver builds.
 *
 * Production shapes this is modelled on (2026-09-03):
 *   Brightsphere      2 retained_earnings rows, both is_system_account,
 *                     but only ONE is_active — the resolver's is_active filter
 *                     means it is NOT contested.
 *   Test Company E2E  3 rows, all system, all active — genuinely contested.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getSystemAccount,
  getSystemAccountCandidates,
  clearSystemAccountCache,
} from '@/modules/accounting/services/gl/systemAccountResolver';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const row = (id: string, code: string, name: string, createdAt: string, type = 'equity') => ({
  id, account_code: code, account_name: name, account_type: type,
  account_subtype: 'retained_earnings', created_at: new Date(createdAt),
});

beforeEach(() => {
  vi.clearAllMocks();
  clearSystemAccountCache();
});

describe('getSystemAccountCandidates', () => {
  it('returns the single account when the role is uncontested', async () => {
    sqlMock.mockResolvedValue([row('re-1', '3200', 'Retained Earnings', '2026-01-01')]);

    const candidates = await getSystemAccountCandidates('retained_earnings', COMPANY);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.accountCode).toBe('3200');
  });

  it('returns an empty list when nothing claims the role', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getSystemAccountCandidates('retained_earnings', COMPANY)).toEqual([]);
  });

  it('returns every claimant when the role is contested', async () => {
    // Test Company E2E's shape: three active system rows for one role.
    sqlMock.mockResolvedValue([
      row('re-1', 'SYS11', 'Retained Income', '2026-04-02'),
      row('re-2', '3200', 'Retained Earnings', '2026-04-13'),
      row('re-3', '3201', 'Retained Earnings (old)', '2026-05-01'),
    ]);

    const candidates = await getSystemAccountCandidates('retained_earnings', COMPANY);

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.accountCode).sort()).toEqual(['3200', '3201', 'SYS11']);
  });

  it('does not issue a query of its own — it reads the resolver cache', async () => {
    sqlMock.mockResolvedValue([row('re-1', '3200', 'Retained Earnings', '2026-01-01')]);

    await getSystemAccount('retained_earnings', COMPANY);
    const callsAfterResolve = sqlMock.mock.calls.length;
    await getSystemAccountCandidates('retained_earnings', COMPANY);

    expect(sqlMock.mock.calls.length).toBe(callsAfterResolve);
  });

  it('leaves getSystemAccount resolving a contest rather than throwing', async () => {
    sqlMock.mockResolvedValue([
      row('re-1', 'SYS11', 'Retained Income', '2026-04-02'),
      row('re-2', '3200', 'Retained Earnings', '2026-04-13'),
    ]);

    // Other callers depend on this: deterministic pick, newer wins, no throw.
    const resolved = await getSystemAccount('retained_earnings', COMPANY);
    expect(resolved.accountCode).toBe('3200');
  });
});
