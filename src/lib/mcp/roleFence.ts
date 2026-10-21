/**
 * The role fence for MCP tools: every write tool, and the reads that return per-employee payroll
 * data (McpTool.requiresWriteRole). A token's scope says what the user consented to; this says what
 * their ROLE in the company allows — the same owner/admin/manager set the HTTP routes enforce. A token
 * minted while its user could write keeps its scopes after a demotion, so the role is judged per call.
 */
import { canWrite } from '@/lib/auth/writeRoles';
import type { McpTool, McpToolContext } from './types';

/** The refusal text, or null when the call may go on. A missing role is refused. */
export function roleFenceRefusal(tool: McpTool, ctx: McpToolContext): string | null {
  if (!(tool.write || tool.requiresWriteRole) || canWrite(ctx.companyRole)) return null;
  const what = tool.write ? 'changes company data' : 'returns per-employee payroll data';
  return `${tool.name} ${what}, which only the owner, admin and manager roles may use. `
    + 'This connection belongs to a user whose role in this company does not allow it.';
}
