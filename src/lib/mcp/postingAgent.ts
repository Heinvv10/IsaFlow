/**
 * Posting-agent stamp for MCP-originated ledger writes — ZERO imports.
 *
 * gl_journal_entries.posting_agent already carries `human:<userId>` and
 * `legacy:*` values. Stamping `mcp:<tool>:v1` is what makes agent work
 * reviewable and reversible as a set — the safety model for this slice is
 * attribution, not per-action confirmation.
 */
export function mcpPostingAgent(toolName: string): string {
  return `mcp:${toolName}:v1`;
}
