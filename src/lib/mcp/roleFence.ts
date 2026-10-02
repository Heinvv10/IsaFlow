/**
 * The role fence for MCP tools that return per-employee payroll data or change payroll
 * (McpTool.requiresWriteRole). A token's scope says what the user consented to; this says what
 * their ROLE in the company allows — the same owner/admin/manager set the HTTP routes enforce.
 */
import { canWrite } from '@/lib/auth/writeRoles';
import type { McpTool, McpToolContext } from './types';

/** The refusal text, or null when the call may go on. A missing role is refused. */
export function roleFenceRefusal(tool: McpTool, ctx: McpToolContext): string | null {
  if (!tool.requiresWriteRole || canWrite(ctx.companyRole)) return null;
  return `${tool.name} returns or changes per-employee payroll data, which only the owner, admin and manager roles may use. `
    + 'This connection belongs to a user whose role in this company does not allow it.';
}
