/**
 * D3 round 3 — the MCP payroll tools answer to the caller's ROLE in the company, not only to the token's
 * scope. Through the real registry: a viewer-bound token that holds read:payroll / write:payroll is refused
 * before any handler of a per-employee or payroll-write tool; an owner-bound token reaches it. list_employees
 * (the real handler) gives a viewer names and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()), withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const audit = vi.hoisted(() => ({
  recordToolCall: vi.fn(async () => undefined),
  acquireIdempotencyLock: vi.fn(async () => undefined),
  findIdempotentReplay: vi.fn(async () => ({ status: 'none' as const })),
}));
vi.mock('@/lib/mcp/audit', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp/audit')>()), ...audit }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true as const, handle: null })), refundForTool: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeQueryService', () => ({
  listPayrollEmployeesPage: vi.fn(),
  payrollEmployeeCursorParts: vi.fn(() => ['a', 'b', 'c']),
}));

import { McpRegistry } from '@/lib/mcp/registry';
import { listPayrollEmployeesPage } from '@/modules/accounting/services/payroll/payrollEmployeeQueryService';
import { listEmployeesTool, listPayRunsTool } from '@/lib/mcp/tools/payroll';
import { emp201StatusTool, irp5DataTool } from '@/lib/mcp/tools/payrollSars';
import { listEmployeeComponentsTool, getEmployeeTool, listPayrollComponentsTool } from '@/lib/mcp/tools/payrollComponents';
import { createPayRunTool, postPayrollJournalTool } from '@/lib/mcp/tools/writePayroll';
import { calculatePayRunTool, approvePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import { createEmployeeTool, updateEmployeeTool, assignEmployeeComponentTool, endEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployees';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const ctxFor = (companyRole: string | null | undefined): McpToolContext => ({
  userId: 'u-1', companyId: COMPANY, tokenJti: 'j', oauthAppId: null, companyRole,
  scopes: ['read:payroll', 'write:payroll', 'write:post'],
});

/** Per-employee data or a payroll write — a viewer is refused. */
const FENCED: McpTool[] = [
  getEmployeeTool, listEmployeeComponentsTool, irp5DataTool,
  createPayRunTool, postPayrollJournalTool, calculatePayRunTool, approvePayRunTool,
  createEmployeeTool, updateEmployeeTool, assignEmployeeComponentTool, endEmployeeComponentTool,
];
/** Totals or company configuration only — open to any role holding the scope. */
const OPEN: McpTool[] = [listPayRunsTool, emp201StatusTool, listPayrollComponentsTool];

function registryWith(tool: McpTool) {
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '"reached"' }] }));
  const registry = new McpRegistry();
  registry.register({ ...tool, handler });
  return { registry, handler };
}
const args = { idempotency_key: 'k-1' };

beforeEach(() => vi.clearAllMocks());

describe('registry role fence', () => {
  it.each(FENCED.map((t) => [t.name, t] as const))('%s: declares the fence', (_n, tool) => {
    expect(tool.requiresWriteRole).toBe(true);
  });

  it.each(FENCED.map((t) => [t.name, t] as const))('%s: a viewer-bound token is refused and the handler never runs', async (_n, tool) => {
    const { registry, handler } = registryWith(tool);
    for (const role of ['viewer', null, undefined, 'accountant']) {
      const r = await registry.call(tool.name, { ...args }, ctxFor(role));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/owner, admin and manager/);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(FENCED.map((t) => [t.name, t] as const))('%s: an owner-bound token reaches the handler', async (_n, tool) => {
    for (const role of ['owner', 'admin', 'manager']) {
      const { registry, handler } = registryWith(tool);
      const r = await registry.call(tool.name, { ...args }, ctxFor(role));
      expect(r.isError).toBeFalsy();
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it.each(OPEN.map((t) => [t.name, t] as const))('%s: totals/config tool stays open to a viewer', async (_n, tool) => {
    const { registry, handler } = registryWith(tool);
    const r = await registry.call(tool.name, { ...args }, ctxFor('viewer'));
    expect(r.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('list_employees — names only for a viewer', () => {
  const ROW = {
    id: 'e1', employeeNumber: 'EMP001', firstName: 'Thandi', lastName: 'Mokoena', status: 'active',
    employmentType: 'permanent', startDate: '2024-03-01', endDate: null, costCentreId: 'cc1', uifExcluded: false,
    idNumber: '8001015009087', taxNumber: '0123456789', idNumberMasked: '*********9087',
  };
  beforeEach(() => {
    vi.mocked(listPayrollEmployeesPage).mockResolvedValue({ rows: [ROW], rowsTotal: 1, universeTotal: 1, hasMore: false, postedThrough: null } as never);
  });
  const run = async (role: string, a: Record<string, unknown> = {}) => {
    const registry = new McpRegistry();
    registry.register(listEmployeesTool);
    return registry.call('list_employees', a, ctxFor(role));
  };

  it('viewer: id, number, name, status, employment type — no ID/tax number, masked or not, no dates', async () => {
    const r = await run('viewer');
    expect(r.isError).toBeFalsy();
    const text = r.content[0]!.text;
    expect(text).toContain('Thandi');
    // The same fields the HTTP list gives a viewer (id, number, names, employment type): no status either.
    const row = (JSON.parse(text) as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(Object.keys(row).sort()).toEqual(['employee_number', 'employment_type', 'first_name', 'id', 'last_name']);
    expect(text).not.toMatch(/8001015009087|0123456789|9087|id_number|tax_number|start_date|cost_centre/);
  });
  it('viewer asking to reveal identity numbers is refused', async () => {
    const r = await run('viewer', { reveal_identity_numbers: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/owner, admin or manager/);
  });
  it('manager: the row as before, masked number present', async () => {
    const text = (await run('manager')).content[0]!.text;
    expect(text).toContain('id_number_masked');
    expect(text).toContain('start_date');
  });
});
