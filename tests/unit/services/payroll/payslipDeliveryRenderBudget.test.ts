/**
 * Wave 7 PX security review: qpdf work is bounded by the rate limit and the time budget.
 *  - a rate-limited request renders (and so starts qpdf) for no slip;
 *  - the limit is charged for the slips that will be sent, before the first render;
 *  - rendering stops once half the budget is spent (at least one slip); the rest are `remaining`, none sent;
 *  - a slip that cannot be encrypted refuses the whole request (503) with nothing claimed or sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ now: 0, renders: 0, renderMs: 0, failRender: false, claims: 0 }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => EMPLOYEES), withSavepoint: vi.fn(), withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/payroll/payslipEmailSettings', () => ({
  companyPayslipEmailEnabled: vi.fn(async () => true), PAYSLIP_EMAIL_FLAG: 'payroll_payslip_email',
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  withBoundedLockWait: vi.fn(async (_run: string, fn: (tx: unknown) => Promise<unknown>) => fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('payroll_run_headers')) return [{ status: 'approved', final_at: new Date('2026-11-25T10:00:00Z') }];
    if (q.includes('payroll_employees')) return EMPLOYEES;
    return [];
  })),
}));
vi.mock('@/modules/accounting/services/payroll/payslipModel', () => ({
  PayslipNotFound: class extends Error {},
  getPayslips: vi.fn(async () => RUN),
}));
vi.mock('@/modules/accounting/services/payroll/payslipDeliveryRecord', () => ({
  attemptStates: vi.fn(async () => new Map()), lastSentTo: vi.fn(async () => new Map()),
  recordClaim: vi.fn(async () => { h.claims += 1; }), recordOutcome: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payslipEmailPdf', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payslipEmailPdf')>(),
  renderEmailPayslip: vi.fn(async () => {
    h.renders += 1;
    h.now += h.renderMs;
    if (h.failRender) {
      const { PayslipEncryptionFailed } = await import('@/modules/accounting/services/payroll/payslipEncrypt');
      throw new PayslipEncryptionFailed('qpdf is not installed on this server');
    }
    return { filename: 'p.pdf', pdf: Buffer.from('%PDF-'), sha256: 'a'.repeat(64), plaintextSha256: 'b'.repeat(64) };
  }),
}));

import { sendPayslipEmails } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { PayslipEmailRefusal } from '@/modules/accounting/services/payroll/payslipDeliveryRefusal';

const N = 6;
const ids = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
const EMPLOYEES = ids.map((id, i) => ({ id, email: `e${i}@example.invalid`, id_number: `800101500908${i}`, passport_number: null }));
const RUN = {
  runId: 'r', periodMonth: 11, periodYear: 2026, runDate: null, final: true, detailsAsAt: 'approval', employer: { name: 'Co', address: '' },
  payslips: ids.map((employeeId, i) => ({ employeeId, employeeNumber: `E-${i}`, employeeName: `Emp ${i}` })),
};
const actor = { userId: 'u', userEmail: 'u@example.invalid', ip: '127.0.0.1', userAgent: undefined, sessionId: 's' };
const mailer = vi.fn(async () => ({ success: true, messageId: '<m@example.invalid>' }));

function send(admit: (count: number) => Promise<boolean>, limits = { maxSends: 20, budgetMs: 20_000 }) {
  return sendPayslipEmails({ companyId: 'c', runId: 'r', resend: false, actor, mailer: mailer as never, admit, limits });
}

beforeEach(() => {
  Object.assign(h, { now: 1_000_000, renders: 0, renderMs: 0, failRender: false, claims: 0 });
  mailer.mockClear();
  vi.spyOn(Date, 'now').mockImplementation(() => h.now);
});

describe('payslip email: qpdf bounded by the rate limit and the budget', () => {
  it('a rate-limited request starts no render (no qpdf) and sends nothing', async () => {
    const admit = vi.fn(async () => false);
    await expect(send(admit)).rejects.toMatchObject({ reason: 'RATE_LIMITED' });
    expect(admit).toHaveBeenCalledWith(N);
    expect(h.renders).toBe(0);
    expect(h.claims).toBe(0);
    expect(mailer).not.toHaveBeenCalled();
  });

  it('the limit is charged before the first render', async () => {
    const order: string[] = [];
    const admit = vi.fn(async () => { order.push(`admit@${h.renders}`); return true; });
    const out = await send(admit);
    expect(order).toEqual(['admit@0']);
    expect(out.sent).toHaveLength(N);
    expect(h.renders).toBe(N);
  });

  it('rendering stops once half the budget is spent; the rest remain, unsent', async () => {
    h.renderMs = 4_000; // budget 20 s: renders at 0, 4, 8 s start; at 12 s > 10 s it stops
    const out = await send(async () => true);
    expect(h.renders).toBe(3);
    expect(out.sent).toHaveLength(3);
    expect(out.remaining).toBe(N - 3);
    expect(mailer).toHaveBeenCalledTimes(3);
  });

  it('at least one slip is rendered even when one render outlasts the budget', async () => {
    h.renderMs = 60_000;
    const out = await send(async () => true);
    expect(h.renders).toBe(1);
    expect(out.sent).toHaveLength(1);
    expect(out.remaining).toBe(N - 1);
  });

  it('a slip that cannot be encrypted refuses the whole request: 503, nothing claimed or sent', async () => {
    h.failRender = true;
    const err = await send(async () => true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayslipEmailRefusal);
    expect(err).toMatchObject({ reason: 'ENCRYPTION_UNAVAILABLE', status: 503 });
    expect(h.claims).toBe(0);
    expect(mailer).not.toHaveBeenCalled();
  });
});
