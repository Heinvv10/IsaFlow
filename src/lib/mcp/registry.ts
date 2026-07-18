/**
 * MCP tool registry — the security fence for every tools/call.
 *
 * call() order is the invariant (proven by tests, not convention):
 *   resolve tool → scope check → write:post check → idempotency-key presence
 *   → replay lookup → handler → audit.
 * Rejections happen BEFORE the handler runs and are audited as 'rejected'.
 * Handler errors return a GENERIC message — never stack traces or SQL.
 */
import { log } from '@/lib/logger';
import type { McpTool, McpToolContext, McpToolResult } from './types';
import { findIdempotentReplay, hashArgs, recordToolCall } from './audit';

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const GENERIC_FAILURE = 'The operation failed. Please try again or contact support.';

export class McpRegistry {
  private tools = new Map<string, McpTool>();

  register(tool: McpTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`McpRegistry: duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  getManifest(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Full tool records — used by manifest/security suite tests, not clients. */
  listTools(): McpTool[] {
    return [...this.tools.values()];
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    ctx: McpToolContext,
  ): Promise<McpToolResult> {
    const started = Date.now();
    const argsHash = hashArgs(args);

    const reject = async (text: string, idempotencyKey: string | null): Promise<McpToolResult> => {
      await recordToolCall({
        ctx, tool: name, argsHash, idempotencyKey,
        status: 'rejected', result: null, durationMs: Date.now() - started,
      });
      return errorResult(text);
    };

    const tool = this.tools.get(name);
    if (!tool) return reject(`Unknown tool: ${name}`, null);

    if (tool.scope && !ctx.scopes.includes(tool.scope)) {
      return reject(`Insufficient scope: this tool requires ${tool.scope}`, null);
    }

    if (tool.requiresPost && !ctx.scopes.includes('write:post')) {
      return reject(
        'This operation posts irreversible entries and requires the write:post permission, which this connection was not granted.',
        null,
      );
    }

    const rawKey = args.idempotency_key;
    const idempotencyKey =
      typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null;

    if (tool.write && !idempotencyKey) {
      return reject('idempotency_key is required for write operations', null);
    }

    if (tool.write && idempotencyKey) {
      const replay = await findIdempotentReplay(ctx.companyId, name, idempotencyKey);
      if (replay) {
        log.info('MCP: idempotent replay served', { tool: name, companyId: ctx.companyId }, 'mcp');
        return replay;
      }
    }

    try {
      const result = await tool.handler(args, ctx);
      await recordToolCall({
        ctx, tool: name, argsHash, idempotencyKey,
        status: 'ok', result, durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      log.error(
        'MCP tool handler failed',
        { tool: name, companyId: ctx.companyId, err: err instanceof Error ? err.message : String(err) },
        'mcp',
      );
      await recordToolCall({
        ctx, tool: name, argsHash, idempotencyKey,
        status: 'error', result: null, durationMs: Date.now() - started,
      });
      return errorResult(GENERIC_FAILURE);
    }
  }
}
