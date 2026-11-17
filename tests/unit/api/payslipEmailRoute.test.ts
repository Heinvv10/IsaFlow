/**
 * Wave 6 PE (spec rule 11): the send route is built around `sendEmail` and nothing else. A capture mailer exists only
 * in the integration suite, which builds its own route with payslipEmailRoute(capture); no environment variable
 * can choose one, so the page's route is pinned to sendEmail here, and the source is checked for an env switch.
 */
import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

const sendEmail = vi.fn();
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));
vi.mock('@/lib/payslipEmailApi', () => ({ payslipEmailRoute: vi.fn((mailer: unknown) => ({ builtWith: mailer })) }));

describe('POST /api/payroll/runs/[id]/payslips/email', () => {
  it('is payslipEmailRoute(sendEmail)', async () => {
    const route = (await import('../../../pages/api/payroll/runs/[id]/payslips/email')).default as unknown as { builtWith: unknown };
    expect(route.builtWith).toBe(sendEmail);
  });

  it('no production file of the feature reads the environment to pick a mailer', () => {
    for (const f of ['pages/api/payroll/runs/[id]/payslips/email.ts', 'src/lib/payslipEmailApi.ts',
      'src/modules/accounting/services/payroll/payslipDeliveryService.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/process\.env/);
    }
  });
});
