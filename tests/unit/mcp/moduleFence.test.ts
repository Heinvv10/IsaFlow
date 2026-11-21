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

  it('#1670 Codex: a payroll write tool (calculate_pay_run, even a dry run) needs Payroll read as well: write alone returns employee pay', async () => {
    const calc = tool({ name: 'calculate_pay_run', write: true, permissionModule: 'payroll' });
    db.allowed.add('payroll:write');
    expect(await moduleFenceRefusal(calc, { dry_run: true }, ctx)).toMatch(/calculate_pay_run needs Payroll read/);
    db.allowed.add('payroll:read');
    expect(await moduleFenceRefusal(calc, { dry_run: true }, ctx)).toBeNull();
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
    db.allowed.add('payroll:read');
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

  it('credit_note_by_id leaves a note this company does not have to the tool (it answers Not found before any write)', async () => {
    const t = tool({ name: 'approve_credit_note', approveModule: 'credit_note_by_id' });
    db.noteType = null;
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toBeNull();
  });

  it('round 4 (H1): a whitespace-padded credit_note_id resolves as the handler\'s strArg does, and is asked the same Approve', async () => {
    const t = tool({ name: 'cancel_credit_note', approveModule: 'credit_note_by_id' });
    for (const padded of [` ${NOTE}`, `${NOTE} `, `\t${NOTE}\n`]) {
      expect(await moduleFenceRefusal(t, { credit_note_id: padded }, ctx), JSON.stringify(padded)).toMatch(/cancel_credit_note: .*Approve/);
    }
    db.allowed.add('customers:approve');
    expect(await moduleFenceRefusal(t, { credit_note_id: ` ${NOTE}` }, ctx)).toBeNull();
  });

  it('round 4: an unresolvable credit_note_id is REFUSED, never passed (missing, empty, non-string, not a uuid)', async () => {
    const t = tool({ name: 'cancel_credit_note', approveModule: 'credit_note_by_id' });
    for (const args of [{}, { credit_note_id: '' }, { credit_note_id: '   ' }, { credit_note_id: 7 }, { credit_note_id: [NOTE] }, { credit_note_id: 'nope' }, { credit_note_id: `${NOTE}x` }]) {
      expect(await moduleFenceRefusal(t, args, ctx), JSON.stringify(args)).toMatch(/cancel_credit_note: (credit_note_id is required|invalid credit_note_id)/);
    }
  });

  it('round 4: a credit note whose type the fence cannot resolve is refused', async () => {
    const t = tool({ name: 'cancel_credit_note', approveModule: 'credit_note_by_id' });
    db.noteType = 'something_else';
    expect(await moduleFenceRefusal(t, { credit_note_id: NOTE }, ctx)).toMatch(/no type the fence can resolve/);
  });

  it('by_subledger asks Suppliers for ap and Customers for ar', async () => {
    const t = tool({ name: 'settle_by_contra', approveModule: 'by_subledger' });
    db.allowed.add('customers:approve');
    expect(await moduleFenceRefusal(t, { subledger: 'ar' }, ctx)).toBeNull();
    expect(await moduleFenceRefusal(t, { subledger: 'ap' }, ctx)).toMatch(/Suppliers/);
  });

  it('round 4 (H2): a padded subledger is read as the handler reads it (" ar " is ar), and asks the same Approve', async () => {
    const t = tool({ name: 'settle_by_contra', approveModule: 'by_subledger' });
    expect(await moduleFenceRefusal(t, { subledger: ' ar ' }, ctx)).toMatch(/settle_by_contra: .*Customers/);
    expect(await moduleFenceRefusal(t, { subledger: '\tap\n' }, ctx)).toMatch(/Suppliers/);
    db.allowed.add('customers:approve');
    expect(await moduleFenceRefusal(t, { subledger: ' ar ' }, ctx)).toBeNull();
  });

  it('round 4: an unresolvable subledger is refused (missing, empty, non-string, other, wrong case)', async () => {
    const t = tool({ name: 'settle_by_contra', approveModule: 'by_subledger' });
    for (const args of [{}, { subledger: '' }, { subledger: 3 }, { subledger: ['ar'] }, { subledger: 'AR' }, { subledger: 'both' }]) {
      expect(await moduleFenceRefusal(t, args, ctx), JSON.stringify(args)).toMatch(/settle_by_contra: subledger must be/);
    }
  });

  it('per_document and an undeclared tool are not fenced here', async () => {
    expect(await moduleFenceRefusal(tool({ name: 'bulk_approve_credit_notes', approveModule: 'per_document' }), {}, ctx)).toBeNull();
    expect(await moduleFenceRefusal(tool({ name: 'list_accounts', write: false }), {}, ctx)).toBeNull();
    expect(checkPermission).not.toHaveBeenCalled();
  });
});

describe('every MCP tool with a data-dependent module fence fails closed (round 4)', () => {
  it('the dependent kinds are exactly the ones this file proves; a new kind needs a resolver test here', async () => {
    const { MCP_TOOLS } = await import('@/lib/mcp/toolIndex');
    const kinds = new Set(MCP_TOOLS.map((t) => t.approveModule).filter((m) => m === 'credit_note_by_id' || m === 'by_subledger' || m === 'per_document'));
    expect([...kinds].sort()).toEqual(['by_subledger', 'credit_note_by_id', 'per_document']);
    const known = new Set(['credit_note_by_id', 'by_subledger', 'per_document', 'suppliers', 'customers', 'accounts', 'payroll', 'budgets', 'banking', 'vat', 'group', 'accountant', 'items']);
    expect(MCP_TOOLS.map((t) => t.approveModule).filter((m) => m !== undefined && !known.has(m))).toEqual([]);
  }, 120_000); // the first import of the whole tool index is slow

  it('each real tool of a dependent kind is refused for padded-but-permitted args only with the Approve it asks, and for unresolvable args always', async () => {
    const { MCP_TOOLS } = await import('@/lib/mcp/toolIndex');
    const byId = MCP_TOOLS.filter((t) => t.approveModule === 'credit_note_by_id');
    const bySub = MCP_TOOLS.filter((t) => t.approveModule === 'by_subledger');
    expect(byId.map((t) => t.name).sort()).toEqual(['approve_credit_note']); // cancel_credit_note asks per document: a draft needs no Approve
    expect(bySub.map((t) => t.name)).toEqual(['settle_by_contra']);
    for (const t of byId) {
      expect(await moduleFenceRefusal(t, { credit_note_id: ` ${NOTE} ` }, ctx), t.name).toMatch(/Approve/);
      for (const args of [{}, { credit_note_id: 5 }, { credit_note_id: 'x' }]) expect(await moduleFenceRefusal(t, args, ctx), `${t.name} ${JSON.stringify(args)}`).not.toBeNull();
    }
    for (const t of bySub) {
      expect(await moduleFenceRefusal(t, { subledger: ' ar ' }, ctx)).toMatch(/Approve/);
      for (const args of [{}, { subledger: 1 }, { subledger: 'x' }]) expect(await moduleFenceRefusal(t, args, ctx)).not.toBeNull();
    }
  }, 120_000);
});
