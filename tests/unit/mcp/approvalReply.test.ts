import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/neon', () => {
  // Importing the registry builds tagged fragments; none may execute here.
  const fragment = { then: () => { throw new Error('Unexpected SQL execution'); } };
  const sql = Object.assign(vi.fn(() => fragment), { unsafe: vi.fn(() => fragment) });
  return { sql, withSavepoint: (_name: string, fn: () => unknown) => fn(), withTransaction: vi.fn() };
});
import { approvalRequiredReason, approvalRequiredReply } from '@/lib/mcp/approvalReply';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
const tool = (name: string, properties: Record<string, unknown> = {}) => ({ name, inputSchema: { type: 'object', properties } });
const registered = MCP_TOOLS.map((t) => ({ name: t.name, inputSchema: t.inputSchema as Record<string, unknown>, scope: t.scope, requiresPost: t.requiresPost === true }));

/** Where approval_id sits in a schema, at any depth; null when the tool cannot carry one. */
function approvalPath(schema: unknown, path: string[] = []): string[] | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return null;
  if ('approval_id' in properties) return path;
  for (const [key, child] of Object.entries(properties)) {
    const found = approvalPath(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

describe('approvalRequiredReply', () => {
  it('never tells a tool that cannot carry an approval to retry with one', () => {
    for (const name of ['settle_by_contra', 'close_fiscal_period', 'approve_pay_run', 'bulk_allocate_bank_transactions']) {
      const reply = approvalRequiredReply(tool(name));
      expect(reply, name).toMatch(/cannot carry/i);
      expect(reply, name).not.toMatch(/then retry/i);
    }
  });
  it('does not send a person to an app screen that cannot apply the approval', () => {
    // The routes forward approvalId, but no screen sends one: year-end/index.tsx,
    // supplier-invoices/[invoiceId].tsx and BulkActionBar.tsx.
    for (const name of ['year_end_close', 'bulk_approve_supplier_invoices']) {
      for (const text of [approvalRequiredReply(tool(name)), approvalRequiredReason(name)]) {
        expect(text, name).not.toMatch(/accepts the approval|in the IsaFlow app/i);
        expect(text, name).toMatch(/neither this connector nor the IsaFlow app screens can apply/i);
        expect(text, name).toMatch(/owner or admin/i);
      }
    }
  });
  it('tells a tool that takes approval_id how to use it', () => {
    const reply = approvalRequiredReply(tool('void_payment', { approval_id: { type: 'string' } }));
    expect(reply).toMatch(/request_operation_approval/);
    expect(reply).toMatch(/approval_id/);
  });
});

describe('every registered tool is told the route that exists', () => {
  it('a tool carrying approval_id at any depth is told to pass it, and where', () => {
    const carriers = registered.filter((t) => approvalPath(t.inputSchema) !== null);
    expect(carriers.map((t) => t.name)).toContain('execute_bank_operation');
    for (const carrier of carriers) {
      const reply = approvalRequiredReply(carrier);
      expect(reply, carrier.name).not.toMatch(/cannot carry/i);
      expect(reply, carrier.name).toContain(`call ${carrier.name} again with its approval_id`);
      for (const segment of approvalPath(carrier.inputSchema)!) expect(reply, carrier.name).toContain(segment);
    }
  });
  it('a bank allocation or reversal tool names the prepared bank route, not "no connector tool"', () => {
    // prepare_bank_operation -> request_operation_approval -> execute_bank_operation
    // applies an approval to any bank allocation or reversal. A new allocation
    // tool is picked up here by name, so it cannot ship with the false reply.
    const family = registered.filter((t) => t.scope === 'write:bank-tx' && t.requiresPost && /allocat/.test(t.name));
    expect(family.map((t) => t.name).sort()).toEqual(expect.arrayContaining(
      ['allocate_bank_transaction', 'bulk_allocate_bank_transactions', 'reverse_allocations']));
    for (const member of family) {
      for (const text of [approvalRequiredReply(member), approvalRequiredReason(member.name)]) {
        expect(text, member.name).not.toMatch(/no connector tool/i);
        for (const step of ['prepare_bank_operation', 'request_operation_approval', 'execute_bank_operation']) expect(text, member.name).toContain(step);
      }
    }
  });
  it('every connector tool a reply names exists and can carry approval_id', () => {
    const names = new Set(registered.map((t) => t.name));
    for (const t of registered) {
      const reply = approvalRequiredReply(t);
      const cited = [...reply.matchAll(/\bcall ([a-z_]+)\b/g)].map((m) => m[1]!);
      for (const name of cited) {
        expect(names.has(name), `${t.name} cites ${name}`).toBe(true);
        expect(approvalPath(registered.find((r) => r.name === name)!.inputSchema), `${t.name} cites ${name}`).not.toBeNull();
      }
    }
  });
});
