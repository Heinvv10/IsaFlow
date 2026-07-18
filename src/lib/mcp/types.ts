/**
 * MCP tool registry types — the contract every tool and the transport share.
 *
 * SECURITY: McpToolContext is built from the authenticated request ONLY.
 * companyId/userId never come from tool args — no tool accepts a company
 * identifier (cross-tenant probes must be structurally impossible).
 */

export interface McpToolContext {
  userId: string;
  /** From auth context ONLY — never from args. */
  companyId: string;
  scopes: string[];
  /** PAT id or OAuth authorisation id — audit identity of the token. */
  tokenJti: string | null;
  oauthAppId: string | null;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for tool args. Always set additionalProperties: false. */
  inputSchema: Record<string, unknown>;
  /** Required scope; null = any authenticated token may call it. */
  scope: string | null;
  /** Write tools REQUIRE args.idempotency_key (enforced by the registry). */
  write: boolean;
  /** Additionally requires the 'write:post' scope (posting/finalizing). */
  requiresPost?: boolean;
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult>;
}
