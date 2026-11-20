/**
 * The module fence for MCP tools (#1656): the token owner's module permissions, read from the
 * database (company_user_permissions through checkPermission), before any handler runs.
 *   - McpTool.permissionModule ('payroll'): Payroll read for a read tool, Payroll write for a write
 *     tool, as withPayrollModule does for pages/api/payroll/**.
 *   - McpTool.approveModule: the module's Approve for a tool that approves or posts (Hein,
 *     2026-11-19: gate everything). A credit note's module is its type; settle_by_contra's is its
 *     subledger; 'per_document' tools ask per document themselves.
 * tests/unit/mcp/moduleFenceCensus.test.ts fails on a posting or payroll tool that declares neither.
 */
import { sql } from '@/lib/neon';
import { checkPermission } from '@/lib/auth/permissionService';
import { approveRefusedMessage, type ApproveModule } from '@/modules/accounting/services/core/approvePermission';
import type { McpTool, McpToolContext } from './types';

async function creditNoteModule(companyId: string, id: unknown): Promise<ApproveModule | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null; // the tool answers a bad id itself
  const rows = await sql`
    SELECT type FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ type: string }>;
  const type = rows[0]?.type;
  return type === 'customer' ? 'customers' : type === 'supplier' ? 'suppliers' : null;
}

/** The module whose Approve this call takes, or null when the tool decides per document (or names none). */
async function approveModuleFor(tool: McpTool, args: Record<string, unknown>, ctx: McpToolContext): Promise<ApproveModule | null> {
  const m = tool.approveModule;
  if (!m || m === 'per_document') return null;
  if (m === 'credit_note_by_id') return creditNoteModule(ctx.companyId, args.credit_note_id);
  if (m === 'by_subledger') return args.subledger === 'ap' ? 'suppliers' : args.subledger === 'ar' ? 'customers' : null;
  return m;
}

/** The refusal text, or null when the call may go on. */
export async function moduleFenceRefusal(
  tool: McpTool, args: Record<string, unknown>, ctx: McpToolContext,
): Promise<string | null> {
  if (tool.permissionModule) {
    const action = tool.write ? 'write' : 'read';
    if (!(await checkPermission(ctx.companyId, ctx.userId, tool.permissionModule, action))) {
      return `${tool.name} needs Payroll ${action} in your User Access permissions. An owner or admin can grant it.`;
    }
  }
  const module = await approveModuleFor(tool, args, ctx);
  if (module && !(await checkPermission(ctx.companyId, ctx.userId, module, 'approve'))) {
    return `${tool.name}: ${approveRefusedMessage(module, 'or post this')}`;
  }
  return null;
}
