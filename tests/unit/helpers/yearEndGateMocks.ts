/**
 * Stubs of the year-end close's period lock + readiness gate for the mocked-database
 * year-end suites. The real behaviour is tested in tests/unit/services/gl/yearEndPeriodGate.test.ts
 * and periodCloseGate.test.ts; here the gate passes and the lock is one UPDATE on the
 * transaction, its RETURNING counted.
 *
 *   vi.mock('@/modules/accounting/services/gl/yearEndPeriodGate',
 *     async (orig) => (await import('../../helpers/yearEndGateMocks')).yearEndPeriodGateMock(orig));
 */
import { vi } from 'vitest';

type Tx = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

export async function yearEndPeriodGateMock(importOriginal: () => Promise<unknown>) {
  return {
    ...(await importOriginal() as Record<string, unknown>),
    lockAndJudgeYear: vi.fn(async () => ['period-1']),
    lockYear: vi.fn(async (tx: Tx) => (await tx`UPDATE fiscal_periods SET status = 'locked' RETURNING id`).length),
  };
}

/** periodCloseGate with the readiness gate passing and the lock budget a plain call (both vi.fn, so a test can steer them). */
export function periodCloseGateMock() {
  return {
    assertYearCloseReady: vi.fn(async () => undefined),
    withPeriodLockBudget: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
}
