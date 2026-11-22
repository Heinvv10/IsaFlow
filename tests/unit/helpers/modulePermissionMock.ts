/**
 * #1656: the per-module permission gate (checkPermission: withPayrollModule on every payroll route, mayApprove /
 * refuseWithoutApprove on every approval path) reads company_users from Postgres. A route test whose `sql` is a mock
 * would feed it whatever the test queued for something else, so the gate is granted here and the real rule is the
 * subject of tests/unit/api/approvePermissionPaths, payrollModuleCensus and the integration suites. A test of the
 * REFUSAL asks `vi.mocked(checkPermission).mockResolvedValueOnce(false)` (or `mockResolvedValue(false)`) on the
 * mocked export.
 *
 *   vi.mock('@/lib/auth/permissionService', async (orig) =>
 *     (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
 */
import { vi } from 'vitest';

export function permissionServiceAllowing<T extends object>(actual: T): T & { checkPermission: ReturnType<typeof vi.fn> } {
  return { ...actual, checkPermission: vi.fn(async () => true) };
}
