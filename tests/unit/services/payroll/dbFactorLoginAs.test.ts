/**
 * DBF (#1571 review M1): a fund member category factor is a tax valuation input from the fund's certificate, so setting one
 * is refused to a platform-admin Login-as session (R-032, assertNotImpersonating) before any read or write. A plain or
 * percent_of_rfi assignment is not affected by the guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlCalls: string[] = [];
let actor: 'impersonation' | 'self' | 'unknown' = 'impersonation';

vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => actor) }));
vi.mock('@/lib/neon', () => {
  const SQL = (strings: TemplateStringsArray) => { sqlCalls.push(strings.join('?')); return Promise.resolve([]); };
  return { sql: SQL, withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(SQL) };
});

import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { setDbFundMemberContribution } from '@/modules/accounting/services/payroll/definedBenefitAssignment';

const ACTOR = { userId: 'u-1', channel: 'rest' as const };
const assign = (factor: unknown) => assignComponentToEmployee('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 0, '2026-03-01', undefined, true, ACTOR, null, factor);

beforeEach(() => { sqlCalls.length = 0; actor = 'impersonation'; });

describe('setting a defined-benefit factor under Login-as', () => {
  it('is refused before any statement runs', async () => {
    await expect(assign(0.12)).rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(sqlCalls).toEqual([]);
  });

  it('an assignment without a factor does not consult the guard (it fails later, on the mocked empty DB)', async () => {
    await expect(assign(null)).rejects.not.toBeInstanceOf(ImpersonationForbiddenError);
    expect(sqlCalls.length).toBeGreaterThan(0);
  });

  it('a self session passes the guard and goes on to the company checks', async () => {
    actor = 'self';
    await expect(assign(0.12)).rejects.not.toBeInstanceOf(ImpersonationForbiddenError);
    expect(sqlCalls.length).toBeGreaterThan(0);
  });
});

describe('marking the compulsory fund contribution (C) under Login-as (#1571 round 2, M1)', () => {
  it('is refused before any statement runs; a self session goes on to the lookup', async () => {
    await expect(setDbFundMemberContribution('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true, ACTOR))
      .rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(sqlCalls).toEqual([]);
    actor = 'self';
    expect(await setDbFundMemberContribution('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true, ACTOR)).toBe(false);
    expect(sqlCalls.length).toBeGreaterThan(0);
  });
});
