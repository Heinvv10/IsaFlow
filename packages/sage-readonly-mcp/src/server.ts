/**
 * Sage read-only MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Run: bun packages/sage-readonly-mcp/src/server.ts
 *
 * stdout carries protocol messages only; diagnostics go to stderr. A missing or unsafe env file
 * does not stop the server: initialize and tools/list still answer, and every tool call returns
 * the configuration error, so the agent can tell the operator what to fix instead of failing to
 * connect with no reason given.
 */
import { createInterface } from 'node:readline';
import { SageClient } from './client';
import { loadConfig, SageConfigError } from './config';
import { TOOLS, callTool, type ToolResult } from './tools';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'isaflow-sage-readonly', version: '0.1.0' };

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
interface RpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

export type Deps = { client: SageClient; downloadDir: string } | { configError: string };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const result = (id: RpcRequest['id'], r: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result: r });
const error = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One request in, one response out (null for a notification). */
export async function handleMessage(msg: RpcRequest, deps: Deps): Promise<RpcResponse | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only access to one Sage Business Cloud Accounting company. No tool writes to Sage.',
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: READ_ONLY })),
      });
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string') return error(msg.id, -32602, 'tools/call needs params.name');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      let out: ToolResult;
      if ('configError' in deps) {
        out = { content: [{ type: 'text', text: deps.configError }], isError: true };
      } else {
        try {
          out = await callTool(name, args, deps);
        } catch (err) {
          process.stderr.write(`sage-mcp: ${name} failed: ${err instanceof Error ? err.message : String(err)}\n`);
          out = { content: [{ type: 'text', text: `${name} failed` }], isError: true };
        }
      }
      return result(msg.id, out);
    }
    default:
      return isNotification ? null : error(msg.id, -32601, `Method not found: ${msg.method ?? ''}`);
  }
}

export function buildDeps(): Deps {
  try {
    const config = loadConfig();
    return { client: new SageClient(config), downloadDir: config.downloadDir };
  } catch (err) {
    if (err instanceof SageConfigError) return { configError: err.message };
    throw err;
  }
}

async function main(): Promise<void> {
  const deps = buildDeps();
  if ('configError' in deps) process.stderr.write(`sage-mcp: ${deps.configError}\n`);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(line) as RpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const res = await handleMessage(msg, deps);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }
}

if (process.argv[1] && /sage-readonly-mcp\/src\/server\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`sage-mcp: fatal ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
