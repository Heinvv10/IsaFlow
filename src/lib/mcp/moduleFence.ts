/**
 * The module fence for MCP tools (#1656): the token owner's module permissions, read from the
 * database (company_user_permissions through checkPermission), before any handler runs.
 *   - McpTool.permissionModule ('payroll'): Payroll read for a read tool, Payroll write for a write
 *     tool, as withPayrollModule does for pages/api/payroll/**.
 *   - McpTool.approveModule: the module's Approve for a tool that approves or posts (Hein,
 *     2026-11-19: gate everything). A credit note's module is its type; settle_by_contra's is its
 *     subledger; 'per_document' tools ask per document themselves.
 * tests/unit/auth/approvePostEntryCensus.test.ts and payrollModuleCensus.test.ts fail on a posting or payroll tool
 * that declares neither.
 */
import { sql } from '@/lib/neon';
import { checkPermission } from '@/lib/auth/permissionService';
import { approveRefusedMessage, type ApproveModule } from '@/modules/accounting/services/core/approvePermission';
import type { McpTool, McpToolContext } from './types';
import { strArg } from './tools/toolHelpers';
import { UUID_RE } from '@/lib/validation';

/**
 * The module a credit note's Approve belongs to, read the way the handlers read the id: strArg (trimmed), then UUID_RE
 * (round 4, H1: the fence used to regex the RAW value, so " <uuid>" skipped it while the handler trimmed it and went on).
 * A value the fence cannot resolve is a refusal, never a pass; a note this company does not have is null (nothing to
 * approve: the handler answers Not found before any write).
 */
async function creditNoteModule(companyId: string, args: Record<string, unknown>): Promise<ApproveModule | null | { refuse: string }> {
  const id = strArg(args, 'credit_note_id');
  if (!id) return { refuse: 'credit_note_id is required' };
  if (!UUID_RE.test(id)) return { refuse: 'invalid credit_note_id' };
  const rows = await sql`
    SELECT type FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  ` as Array<{ type: string }>;
  if (rows.length === 0) return null;
  const type = rows[0]!.type;
  return type === 'customer' ? 'customers' : type === 'supplier' ? 'suppliers' : { refuse: 'the credit note has no type the fence can resolve' };
}

/** The module whose Approve this call takes; null when the tool decides per document (or the document is not there); or a refusal. */
async function approveModuleFor(
  tool: McpTool, args: Record<string, unknown>, ctx: McpToolContext,
): Promise<ApproveModule | null | { refuse: string }> {
  const m = tool.approveModule;
  if (!m || m === 'per_document') return null;
  if (m === 'credit_note_by_id') return creditNoteModule(ctx.companyId, args);
  if (m === 'by_subledger') {
    const subledger = strArg(args, 'subledger'); // the handler's own reading
    return subledger === 'ap' ? 'suppliers' : subledger === 'ar' ? 'customers' : { refuse: 'subledger must be "ar" (customer invoice) or "ap" (supplier bill)' };
  }
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
  if (module !== null && typeof module === 'object') return `${tool.name}: ${module.refuse}`; // fail closed: an argument the fence cannot resolve
  if (module && !(await checkPermission(ctx.companyId, ctx.userId, module, 'approve'))) {
    return `${tool.name}: ${approveRefusedMessage(module, 'or post this')}`;
  }
  return null;
}
