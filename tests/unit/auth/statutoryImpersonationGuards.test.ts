/**
 * R-032 L5 (Hein's extension): the SARS filing, VAT return and year-end close
 * services refuse a Login-as session as their FIRST act — before any query and
 * before the eFiling config is read — so every caller of the service is covered,
 * not only the routes the integration suite drives. A year-end DRY RUN writes
 * nothing and is not refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fx = vi.hoisted(() => ({ actor: 'impersonation' as 'self' | 'impersonation' | 'unknown', queries: 0 }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: async () => fx.actor }));
vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(async () => { fx.queries++; return []; }), {
    transaction: vi.fn(), unsafe: vi.fn((s: string) => s),
  });
  return { sql, withSavepoint: vi.fn(), withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});
const efilingConfigReads = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/modules/accounting/services/reports/sarsEfilingConfig', () => ({
  getEfilingConfig: () => { efilingConfigReads.n++; return null; },
}));

import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { submitVAT201ToSars } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { markSubmitted } from '@/modules/accounting/services/reports/sarsComplianceService';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';

const C = '00000000-0000-4000-8000-0000000c0032';
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ImpersonationForbiddenError);

describe('statutory services refuse a Login-as session first', () => {
  beforeEach(() => { fx.actor = 'impersonation'; fx.queries = 0; efilingConfigReads.n = 0; });

  it('submitVAT201ToSars — before the eFiling config is read', async () => {
    await refused(submitVAT201ToSars(C, 'sub-1', 'user-1'));
    expect(efilingConfigReads.n).toBe(0);
    expect(fx.queries).toBe(0);
  });

  it('markSubmitted', async () => {
    await refused(markSubmitted(C, 'sub-1', 'REF'));
    expect(fx.queries).toBe(0);
  });

  it('submitVATReturn', async () => {
    await refused(submitVATReturn(C, { periodStart: '2026-07-01', periodEnd: '2026-08-31' }, 'user-1'));
    expect(fx.queries).toBe(0);
  });

  it('closeFiscalYear', async () => {
    await refused(closeFiscalYear(C, '2026', 'user-1'));
    expect(fx.queries).toBe(0);
  });

  it('does not refuse a year-end dry run', async () => {
    await closeFiscalYear(C, '2026', 'user-1', { dryRun: true }).catch(() => undefined);
    expect(fx.queries).toBeGreaterThan(0);
  });
});
