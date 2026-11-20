/**
 * Wave 6 PSP (merge review of #1566, L2): the PSP refusals reach the agent as a tool error with their message, never as
 * a crash, through calculate_pay_run (PspComponentRefused, PspStatusChangedSinceApproval) and assign_employee_component
 * (PspComponentRefused). The services are mocked to throw them; the tool handlers are real.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ calculatePayrollRun: vi.fn(), getPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({ approvePayrollRun: vi.fn(), previewPayrollApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollEmployeeService')>(),
  getPayrollEmployee: vi.fn(async () => ({ id: 'e1' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollComponentService')>(),
  listComponents: vi.fn(async () => [{ id: '33333333-3333-4333-8333-333333333333' }]),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollEmployeeComponentService')>(),
  assignComponentToEmployee: vi.fn(),
}));

import { calculatePayrollRun, getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { PspComponentRefused, PspStatusChangedSinceApproval } from '@/modules/accounting/services/payroll/pspLineRules';
import { calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import { assignEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployeeComponents';

const RUN = '22222222-2222-4222-8222-222222222222';
const ctx = { companyId: 'c', userId: 'u' } as never;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe('calculate_pay_run answers the PSP refusals as tool errors', () => {
  vi.mocked(getPayrollRun).mockResolvedValue({ id: RUN, companyId: 'c', periodMonth: 3, periodYear: 2026, status: 'calculated' } as never);
  it.each([
    ['PSP_COMPONENT_REFUSED', new PspComponentRefused('Employee E1 is a personal service provider, which cannot carry RA (retirement fund contribution).')],
    ['PSP_STATUS_CHANGED_SINCE_APPROVAL', new PspStatusChangedSinceApproval([{ employee: 'E1', was: 'not a personal service provider', now: 'personal service provider (trust)' }])],
  ])('%s', async (_code, err) => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(err);
    const r = await calculatePayRunTool.handler({ run_id: RUN, idempotency_key: 'k' }, ctx) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(err.message.slice(0, 40));
  });
});

describe('assign_employee_component answers the PSP refusal as a tool error', () => {
  it('PSP_COMPONENT_REFUSED', async () => {
    const err = new PspComponentRefused('Employee E1 is a personal service provider, which cannot carry Travel (travel allowance).');
    vi.mocked(assignComponentToEmployee).mockRejectedValueOnce(err);
    const r = await assignEmployeeComponentTool.handler({
      employee_id: '11111111-1111-4111-8111-111111111111', component_id: '33333333-3333-4333-8333-333333333333',
      amount: 1000, effective_from: '2026-03-01', idempotency_key: 'k',
    }, ctx) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('personal service provider');
  });
});
