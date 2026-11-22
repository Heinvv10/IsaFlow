/**
 * #1656, Hein's gate-everything ruling on filing (2026-11-21): marking a return filed or submitted takes the form's module
 * Approve, before anything is read or written: VAT201 -> VAT & Tax, EMP201 / EMP501 / IRP5 -> Payroll, any other form refused
 * whoever asks. Every path: POST /api/accounting/sars/returns/[form]/file, the EMP501 'file' action, the legacy
 * sars-submissions 'mark_submitted', and the ISV eFiling submit (its status poll is not a filing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const allowed = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/permissionService', async (orig) => ({
  ...(await orig<object>()),
  checkPermission: vi.fn(async (_c: string, _u: string, module: string, action: string) => allowed.has(`${module}:${action}`)),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollModule', () => ({ withPayrollModule: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true), INTERACTIVE_REPORT_LIMIT: 10 }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
const svc = vi.hoisted(() => ({
  markReturnFiled: vi.fn(async () => ({ version: { id: 'v', figures: {} }, submission: { id: 's' } })),
  markSubmitted: vi.fn(async () => ({ id: 's' })),
  getSubmission: vi.fn(async () => ({ id: 's', formType: 'VAT201', periodStart: '2026-01-01', periodEnd: '2026-02-28' })),
  submitVAT201ToSars: vi.fn(async () => ({ ok: true })),
  pollVAT201Status: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/modules/accounting/services/returns/fileReturn', () => ({ markReturnFiled: svc.markReturnFiled }));
vi.mock('@/modules/accounting/services/reports/sarsService', () => ({
  SubmissionNotOpenError: class extends Error {}, listSubmissions: vi.fn(), markSubmitted: svc.markSubmitted, getSubmission: svc.getSubmission,
}));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => ({
  assertVatGateClear: vi.fn(async () => undefined), VatGateBlockedError: class extends Error {}, VatGateOverrideForbiddenError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/reports/sarsEfilingSubmissionService', () => ({
  submitVAT201ToSars: svc.submitVAT201ToSars, pollVAT201Status: svc.pollVAT201Status,
  EfilingNotConfiguredError: class extends Error {}, EfilingBlockedError: class extends Error {}, EfilingSubmissionNotFoundError: class extends Error {},
  EfilingAlreadyFiledError: class extends Error {}, EfilingSendUncertainError: class extends Error {},
}));

import { checkPermission } from '@/lib/auth/permissionService';
import { returnApproveModule } from '@/modules/accounting/services/returns/returnForm';
import fileRoute from '../../../pages/api/accounting/sars/returns/[form]/file';
import emp501Route from '../../../pages/api/payroll/emp501/returns/index';
import submissionsRoute from '../../../pages/api/accounting/sars/sars-submissions';
import efilingRoute from '../../../pages/api/accounting/sars/efiling-submit';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const V = '33333333-3333-4333-8333-333333333333';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(handler: unknown, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, headers: {}, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = {
    statusCode: 200, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  await (handler as Handler)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  allowed.clear();
  vi.clearAllMocks();
  // A fresh rule every test: a once-queued answer a refused test never consumed must not leak into the next one.
  vi.mocked(checkPermission).mockReset().mockImplementation(async (_c, _u, module, action) => allowed.has(`${module}:${action}`));
});

describe('returnApproveModule', () => {
  it('VAT201 is vat; EMP201, EMP501 and IRP5 are payroll; anything else none (refused)', () => {
    expect(returnApproveModule('VAT201')).toBe('vat');
    for (const f of ['EMP201', 'EMP501', 'IRP5']) expect(returnApproveModule(f), f).toBe('payroll');
    for (const f of ['ITR14', 'vat201', '']) expect(returnApproveModule(f), f).toBeNull();
  });
});

describe('marking a return filed or submitted takes the form\'s module Approve, before any write', () => {
  it.each([['vat201', 'vat'], ['emp201', 'payroll']])('POST sars/returns/%s/file asks %s Approve', async (form, module) => {
    const body = { versionId: V, reference: 'SARS-1' };
    expect((await call(fileRoute, body, { form })).statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, module, 'approve');
    expect(svc.markReturnFiled).not.toHaveBeenCalled();
    allowed.add(`${module}:approve`);
    expect((await call(fileRoute, body, { form })).statusCode).toBe(200);
    expect(svc.markReturnFiled).toHaveBeenCalledTimes(1);
  });

  it('the EMP501 file action asks Payroll Approve', async () => {
    const body = { action: 'file', versionId: V, reference: 'SARS-1' };
    expect((await call(emp501Route, body)).statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'approve');
    expect(svc.markReturnFiled).not.toHaveBeenCalled();
    allowed.add('payroll:approve');
    expect((await call(emp501Route, body)).statusCode).toBe(200);
  });

  it.each([['VAT201', 'vat'], ['EMP501', 'payroll'], ['EMP201', 'payroll']])('mark_submitted of a %s asks %s Approve', async (formType, module) => {
    svc.getSubmission.mockResolvedValue({ id: 's', formType, periodStart: '2026-01-01', periodEnd: '2026-02-28' });
    const body = { id: 's', action: 'mark_submitted', reference: 'SARS-1' };
    expect((await call(submissionsRoute, body)).statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, module, 'approve');
    expect(svc.markSubmitted).not.toHaveBeenCalled();
    allowed.add(`${module}:approve`);
    expect((await call(submissionsRoute, body)).statusCode).toBe(200);
    expect(svc.markSubmitted).toHaveBeenCalledTimes(1);
  });

  it('mark_submitted of a form no module governs is refused even to a holder of every Approve', async () => {
    svc.getSubmission.mockResolvedValue({ id: 's', formType: 'ITR14', periodStart: '2026-01-01', periodEnd: '2026-02-28' });
    vi.mocked(checkPermission).mockImplementationOnce(async () => true); // whatever module were asked, it would be granted
    expect((await call(submissionsRoute, { id: 's', action: 'mark_submitted', reference: 'R' })).statusCode).toBe(403);
    expect(svc.markSubmitted).not.toHaveBeenCalled();
  });

  it('the ISV eFiling submit asks VAT & Tax Approve; its status poll does not', async () => {
    expect((await call(efilingRoute, { submissionId: 's' })).statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'vat', 'approve');
    expect(svc.submitVAT201ToSars).not.toHaveBeenCalled();
    expect((await call(efilingRoute, { submissionId: 's', action: 'poll' })).statusCode).toBe(200);
    allowed.add('vat:approve');
    expect((await call(efilingRoute, { submissionId: 's' })).statusCode).toBe(200);
    expect(svc.submitVAT201ToSars).toHaveBeenCalledTimes(1);
  });
});
