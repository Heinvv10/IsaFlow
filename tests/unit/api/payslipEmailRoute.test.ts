/**
 * Wave 6 PE (spec rule 11): the send route is built around `sendEmail` and nothing else. A capture mailer exists only
 * in the integration suite, which wraps the same handler in the same middleware; no environment variable can choose
 * one. Pinned here: the page's handler is payslipEmailHandler(sendEmail), its middleware is the one the integration
 * helper repeats, and no feature file reads the environment.
 */
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

const sendEmail = vi.fn();
const pass = (h: unknown) => h;
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));
vi.mock('@/lib/payslipEmailApi', () => ({ payslipEmailHandler: vi.fn((mailer: unknown) => ({ builtWith: mailer })) }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ withAuth: pass }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: pass }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: pass }));
vi.mock('@/lib/auth/withNoStore', () => ({ withNoStore: pass }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: pass }));

const WRAP = 'withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(payslipEmailHandler(';

describe('POST /api/payroll/runs/[id]/payslips/email', () => {
  it('is payslipEmailHandler(sendEmail)', async () => {
    const route = (await import('../../../pages/api/payroll/runs/[id]/payslips/email')).default as unknown as { builtWith: unknown };
    expect(route.builtWith).toBe(sendEmail);
  });

  it('the integration suite wraps the handler in exactly the page\'s middleware', () => {
    expect(readFileSync('pages/api/payroll/runs/[id]/payslips/email.ts', 'utf8')).toContain(`export default ${WRAP}sendEmail, admitPayslipEmails))))));`);
    expect(readFileSync('tests/integration/pe-payslip-email.helpers.ts', 'utf8')).toContain(`= ${WRAP}capture, admitPayslipEmails))))))`);
  });

  it('no production file of the feature reads the environment to pick a mailer', () => {
    for (const f of ['pages/api/payroll/runs/[id]/payslips/email.ts', 'src/lib/payslipEmailApi.ts',
      'src/modules/accounting/services/payroll/payslipDeliveryService.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/process\.env/);
    }
  });
});
