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
  /**
   * Registry-internal, NOT part of the MCP wire format — registry.call()
   * strips it before returning. A charged tool sets `false` when the call
   * succeeded but did no billable work, so the debit is refunded: the obvious
   * case is re-sending a statement whose rows are all already imported, which
   * writes nothing and which import_bank_statement's own description invites.
   * Absent means billable.
   */
  billable?: boolean;
  /**
   * Registry-internal, stripped before the wire. Set by a handler whose SUCCESS
   * wrote nothing — a dry run. Such a result is audited with a NULL idempotency
   * key, because storing it under the key makes the real call that follows
   * (same intent, same natural key) replay the dry run's "posted: 0" forever,
   * forcing the agent to invent a second key for one logical operation. Nothing
   * was written, so there is no duplicate for the key to guard against.
   *
   * Never set this on a handler that wrote: it would free the key for a retry
   * that writes a second time.
   */
  wroteNothing?: boolean;
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
