/**
 * create_employee / update_employee / assign_employee_component /
 * end_employee_component.
 *
 * What is worth pinning:
 *
 *  - an employee with no components is paid NOTHING, and the run costs to R0
 *    without erroring. `create_employee` says so in its reply, because the
 *    silent-zero is the failure an agent cannot see.
 *  - `employment_type` drives the PAYE and UIF engines, so a wrong one is not a
 *    cosmetic fault; only the four real types are accepted.
 *  - id_number and tax_number reach SARS submissions, so their shape is refused
 *    BEFORE the write rather than months later by EasyFile.
 *  - every ownership refusal is answered from a READ, before the write: a
 *    refusal is audited with a NULL idempotency key, so one returned after a
 *    write would free the key for a retry that writes again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  createPayrollEmployee: vi.fn(),
  updatePayrollEmployee: vi.fn(),
  getPayrollEmployee: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', () => ({
  assignComponentToEmployee: vi.fn(),
  endEmployeeComponent: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentService', () => ({
  listComponents: vi.fn(),
}));

import {
  createPayrollEmployee,
  getPayrollEmployee,
  updatePayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollEmployeeService';
import {
  assignComponentToEmployee,
  endEmployeeComponent,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { listComponents } from '@/modules/accounting/services/payroll/payrollComponentService';
import {
  asDate,
  assignEmployeeComponentTool,
  createEmployeeTool,
  endEmployeeComponentTool,
  updateEmployeeTool,
} from '@/lib/mcp/tools/writeEmployees';
import { fmtDate } from '@/lib/fmtDate';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const COMPONENT = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT = '44444444-4444-4444-8444-444444444444';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '55555555-5555-4555-8555-555555555555',
    companyId: COMPANY,
    scopes: ['write:payroll'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const made = {
  id: EMPLOYEE,
  companyId: COMPANY,
  employeeNumber: 'EMP-001',
  firstName: 'Thandi',
  lastName: 'Mokoena',
  employmentType: 'permanent' as const,
  // LOCAL midnight, like the tools build them — a UTC-constructed fixture
  // renders as the previous day through fmtDate on any UTC-minus host.
  startDate: new Date(2025, 3, 1),
  uifExcluded: false,
  medicalAidMainMember: false,
  medicalAidDependantsCount: 0,
};

function newArgs(over: Record<string, unknown> = {}) {
  return {
    employee_number: 'EMP-001',
    first_name: 'Thandi',
    last_name: 'Mokoena',
    employment_type: 'permanent',
    start_date: '2025-04-01',
    ...KEY,
    ...over,
  };
}

describe('create_employee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createPayrollEmployee).mockResolvedValue(made as never);
  });

  it('creates the employee and passes the parsed fields through', async () => {
    const out = parseOk(await createEmployeeTool.handler(newArgs(), ctx()));
    expect(out.id).toBe(EMPLOYEE);
    expect(out.employee_number).toBe('EMP-001');
    const [companyId, data] = vi.mocked(createPayrollEmployee).mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(data.employmentType).toBe('permanent');
    expect(fmtDate(data.startDate)).toBe('2025-04-01');
  });

  it('tells the agent the employee is paid nothing until a component is assigned', async () => {
    // The silent zero is the failure mode: a run over component-less employees
    // costs cleanly to R0 and looks like it worked.
    const out = parseOk(await createEmployeeTool.handler(newArgs(), ctx()));
    expect(String(out.next_step)).toContain('assign_employee_component');
  });

  it('accepts only the four real employment types', async () => {
    for (const t of ['permanent', 'contract', 'casual', 'director']) {
      vi.clearAllMocks();
      vi.mocked(createPayrollEmployee).mockResolvedValue(made as never);
      const r = await createEmployeeTool.handler(newArgs({ employment_type: t }), ctx());
      expect(r.isError).toBeFalsy();
    }
    vi.clearAllMocks();
    const bad = await createEmployeeTool.handler(newArgs({ employment_type: 'freelance' }), ctx());
    expect(errText(bad)).toContain('employment_type must be one of');
    expect(createPayrollEmployee).not.toHaveBeenCalled();
  });

  it('refuses a malformed id_number or tax_number before the write', async () => {
    expect(errText(await createEmployeeTool.handler(newArgs({ id_number: '123' }), ctx())))
      .toBe('id_number must be 13 digits');
    expect(errText(await createEmployeeTool.handler(newArgs({ tax_number: 'ABC' }), ctx())))
      .toContain('valid SARS tax reference');
    expect(createPayrollEmployee).not.toHaveBeenCalled();
  });

  it('accepts well-formed SARS identifiers', async () => {
    const r = await createEmployeeTool.handler(
      newArgs({ id_number: '9001015800086', tax_number: '1234567890' }), ctx(),
    );
    expect(r.isError).toBeFalsy();
    const data = vi.mocked(createPayrollEmployee).mock.calls[0]![1];
    expect(data.idNumber).toBe('9001015800086');
    expect(data.taxNumber).toBe('1234567890');
  });

  it('refuses a required field and an invalid date before the write', async () => {
    expect(errText(await createEmployeeTool.handler(
      { ...newArgs(), first_name: '' }, ctx(),
    ))).toBe('first_name is required');
    expect(errText(await createEmployeeTool.handler(
      newArgs({ start_date: '2026-02-31' }), ctx(),
    ))).toBe('invalid start_date');
    expect(createPayrollEmployee).not.toHaveBeenCalled();
  });

  it('rejects a fractional dependants count', async () => {
    expect(errText(await createEmployeeTool.handler(
      newArgs({ medical_aid_dependants_count: 1.5 }), ctx(),
    ))).toContain('whole number');
  });
});

describe('update_employee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollEmployee).mockResolvedValue(made as never);
    vi.mocked(updatePayrollEmployee).mockResolvedValue({
      ...made, endDate: new Date(2026, 0, 31),
    } as never);
  });

  it('checks the employee is in the company BEFORE updating', async () => {
    vi.mocked(getPayrollEmployee).mockResolvedValue(null);
    const r = await updateEmployeeTool.handler(
      { employee_id: EMPLOYEE, first_name: 'X', ...KEY }, ctx(),
    );
    expect(errText(r)).toBe('Not found');
    expect(updatePayrollEmployee).not.toHaveBeenCalled();
  });

  it('passes only the fields the agent sent', async () => {
    await updateEmployeeTool.handler({ employee_id: EMPLOYEE, last_name: 'Ndlovu', ...KEY }, ctx());
    const patch = vi.mocked(updatePayrollEmployee).mock.calls[0]![2];
    expect(patch).toEqual({ lastName: 'Ndlovu' });
    expect(patch).not.toHaveProperty('firstName');
  });

  it('carries an end_date through as the termination signal', async () => {
    const out = parseOk(await updateEmployeeTool.handler(
      { employee_id: EMPLOYEE, end_date: '2026-01-31', ...KEY }, ctx(),
    ));
    const patch = vi.mocked(updatePayrollEmployee).mock.calls[0]![2];
    expect(fmtDate(patch.endDate!)).toBe('2026-01-31');
    expect(out.end_date).toBe('2026-01-31');
  });

  it('refuses a malformed employee_id before any read', async () => {
    expect(errText(await updateEmployeeTool.handler({ employee_id: 'nope', ...KEY }, ctx())))
      .toBe('invalid employee_id');
    expect(getPayrollEmployee).not.toHaveBeenCalled();
  });
});

describe('assign_employee_component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPayrollEmployee).mockResolvedValue(made as never);
    vi.mocked(listComponents).mockResolvedValue([
      { id: COMPONENT, name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
    ] as never);
    vi.mocked(assignComponentToEmployee).mockResolvedValue({ id: ASSIGNMENT } as never);
  });

  const args = (over: Record<string, unknown> = {}) => ({
    employee_id: EMPLOYEE,
    component_id: COMPONENT,
    amount: 25000,
    effective_from: '2025-04-01',
    ...KEY,
    ...over,
  });

  it('assigns the component and defaults to recurring', async () => {
    const out = parseOk(await assignEmployeeComponentTool.handler(args(), ctx()));
    expect(out.component_name).toBe('Basic Salary');
    expect(out.is_recurring).toBe(true);
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![6]).toBe(true);
  });

  it('honours is_recurring: false for a once-off', async () => {
    await assignEmployeeComponentTool.handler(args({ is_recurring: false }), ctx());
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![6]).toBe(false);
  });

  it('refuses a sub-cent amount', async () => {
    expect(errText(await assignEmployeeComponentTool.handler(args({ amount: 100.005 }), ctx())))
      .toContain('two decimal places');
    expect(assignComponentToEmployee).not.toHaveBeenCalled();
  });

  it('accepts a cent amount whose float product overshoots', async () => {
    // The same IEEE-754 trap that blocked apply_receipt_to_invoice.
    const r = await assignEmployeeComponentTool.handler(args({ amount: 282543.34 }), ctx());
    expect(r.isError).toBeFalsy();
  });

  it('refuses a foreign employee and a foreign component generically', async () => {
    vi.mocked(getPayrollEmployee).mockResolvedValue(null);
    expect(errText(await assignEmployeeComponentTool.handler(args(), ctx()))).toBe('Not found');
    expect(assignComponentToEmployee).not.toHaveBeenCalled();

    vi.mocked(getPayrollEmployee).mockResolvedValue(made as never);
    vi.mocked(listComponents).mockResolvedValue([] as never);
    expect(errText(await assignEmployeeComponentTool.handler(args(), ctx()))).toBe('Not found');
    expect(assignComponentToEmployee).not.toHaveBeenCalled();
  });
});

describe('end_employee_component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(endEmployeeComponent).mockResolvedValue(true as never);
  });

  it('closes the assignment at the given date', async () => {
    const out = parseOk(await endEmployeeComponentTool.handler(
      { assignment_id: ASSIGNMENT, effective_to: '2025-12-31', ...KEY }, ctx(),
    ));
    expect(out.ended).toBe(true);
    const [companyId, id, date] = vi.mocked(endEmployeeComponent).mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(id).toBe(ASSIGNMENT);
    expect(fmtDate(date)).toBe('2025-12-31');
  });

  it('refuses a malformed id or date before the write', async () => {
    expect(errText(await endEmployeeComponentTool.handler(
      { assignment_id: 'nope', effective_to: '2025-12-31', ...KEY }, ctx(),
    ))).toBe('invalid assignment_id');
    expect(errText(await endEmployeeComponentTool.handler(
      { assignment_id: ASSIGNMENT, effective_to: '2025-02-30', ...KEY }, ctx(),
    ))).toBe('invalid effective_to');
    expect(endEmployeeComponent).not.toHaveBeenCalled();
  });
});

describe('asDate — local midnight, not UTC', () => {
  it('round-trips through fmtDate, which reads LOCAL calendar parts', () => {
    // fmtDate deliberately uses local getters: toISOString() there reported the
    // previous day on the UTC+2 host and shifted journal dates across VAT
    // period boundaries. A date built at UTC midnight survives that on a UTC or
    // UTC-plus host and silently loses a day on a UTC-minus one.
    for (const iso of ['2025-04-01', '2025-12-31', '2026-02-28', '2024-02-29']) {
      expect(fmtDate(asDate(iso))).toBe(iso);
    }
  });

  it('is midnight in the LOCAL zone', () => {
    // The discriminator between the two constructions on any host that is not
    // UTC. Under a UTC test runner both pass, so this pins intent rather than
    // catching the bug in CI — `fmtDate` above is the assertion that matters.
    const d = asDate('2025-04-01');
    expect(d.getHours()).toBe(0);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(1);
  });
});

describe('end_employee_component — a miss is not a success', () => {
  it('refuses when the UPDATE matched NO row', async () => {
    // The service scopes through the employee's company, so a stale or foreign
    // assignment matches nothing and the statement succeeds having changed
    // nothing. Reporting `ended: true` there tells an agent an old salary was
    // stopped while it stays live, and the next costed run pays it.
    vi.clearAllMocks();
    vi.mocked(endEmployeeComponent).mockResolvedValue(false as never);
    const r = await endEmployeeComponentTool.handler(
      { assignment_id: ASSIGNMENT, effective_to: '2025-12-31', ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
  });
});
