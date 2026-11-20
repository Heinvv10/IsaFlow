/**
 * #1656: the MCP module fence (src/lib/mcp/moduleFence.ts) asks the token owner's module permissions before a handler:
 * Payroll read / write for a payroll tool, the module's Approve for a posting tool. A credit note's module is its type,
 * settle_by_contra's its subledger; a per-document tool asks inside its handler, so the fence leaves it alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ allowed: new Set<string>(), noteType: 'customer' as string | null }));
vi.mock('@/lib/auth/permissionService', () => ({
  checkPermission: vi.fn(async (_c: string, _u: string, module: string, action: string) => db.allowed.has(`${module}:${action}`)),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => (db.noteType ? [{ type: db.noteType }] : [])) }));

import { checkPermission } from '@/lib/auth/permissionService';
import { moduleFenceRefusal } from '@/lib/mcp/moduleFence';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const ctx = { userId: 'u-1', companyId: '22222222-2222-2222-2222-222222222222' } as McpToolContext;
const NOTE = '33333333-3333-3333-3333-333333333333';
const tool = (over: Partial<McpTool>): McpTool => ({ name: 't', write: true, scope: null, ...over } as McpTool);

beforeEach(() => {
  db.allowed.clear();
  db.noteType = 'customer';
  vi.mocked(checkPermission).mockClear();
});

describe('moduleFenceRefusal (#1656)', () => {
  it('a payroll read tool needs Payroll read; a payroll write tool needs Payroll write', async () => {
    const read = tool({ name: 'list_employees', write: false, permissionModule: 'payroll' });
    const write = tool({ name: 'create_employee', write: true, permissionModule: 'payroll' });
    expect(await moduleFenceRefusal(read, {}, ctx)).toMatch(/list_employees needs Payroll read/);
    db.allowed.add('payroll:read');
    expect(await moduleFenceRefusal(read, {}, ctx)).toBeNull();
    expect(await moduleFenceRefusal(write, {}, ctx)).toMatch(/create_employee needs Payroll write/);
    db.allowed.add('payroll:write');
    expect(await moduleFenceRefusal(write, {}, ctx)).toBeNull();
  });

  it('a posting tool needs its module Approve', async () => {
    const post = tool({ name: 'post_journal', approveModule: 'accounts' });
    expect(await moduleFenceRefusal(post, {}, ctx)).toMatch(/post_journal: .*"Approve" on Chart of Accounts/);
    db.allowed.add('accounts:approve');
    expect(await moduleFenceRefusal(post, {}, ctx)).toBeNull();
    expect(checkPermission).toHaveBeenLastCalledWith(ctx.companyId, ctx.userId, 'accounts', 'approve');
  });

  it('a payroll posting tool needs both Payroll write and Payroll Approve', async () => {
    const approve = tool({ name: 'approve_pay_run', permissionModule: 'payroll', approveModule: 'payroll' });
    db.allowed.add('payroll:write');
    expect(await moduleFenceRefusal(approve, {}, ctx)).toMatch(/approve_pay_run: /);
    db.allowed.add('payroll:approve');
    expect(await moduleFenceRefusal(approve, {}, ctx)).toBeNull();
  });

  it("credit_note_by_id asks the note's own module: Customers for a customer note, Suppliers for a supplier one", async () => {
    const t = tool({ name: 'approve_credit_note', approveModule: 'credit_note_by_id' });
    db.allowed.add('customers:approve');
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toBeNull();
    db.noteType = 'supplier';
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toMatch(/Suppliers/);
    db.allowed.add('suppliers:approve');
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toBeNull();
  });

  it('credit_note_by_id leaves an unknown or malformed id to the tool (it answers not-found itself)', async () => {
    const t = tool({ name: 'approve_credit_note', approveModule: 'credit_note_by_id' });
    expect(await moduleFenceRefusal(t, { credit_note_id: 'nope' }, ctx)).toBeNull();
    db.noteType = null;
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toBeNull();
  });

  it('by_subledger asks Suppliers for ap and Customers for ar', async () => {
    const t = tool({ name: 'settle_by_contra', approveModule: 'by_subledger' });
    db.allowed.add('customers:approve');
    expect(await moduleFenceRefusal(t, { subledger: 'ar' }, ctx)).toBeNull();
    expect(await moduleFenceRefusal(t, { subledger: 'ap' }, ctx)).toMatch(/Suppliers/);
  });

  it('per_document and an undeclared tool are not fenced here', async () => {
    expect(await moduleFenceRefusal(tool({ name: 'bulk_approve_credit_notes', approveModule: 'per_document' }), {}, ctx)).toBeNull();
    expect(await moduleFenceRefusal(tool({ name: 'list_accounts', write: false }), {}, ctx)).toBeNull();
    expect(checkPermission).not.toHaveBeenCalled();
  });
});
