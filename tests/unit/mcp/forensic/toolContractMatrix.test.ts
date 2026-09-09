// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
/** Schema and registry-fence fixtures, NOT successful financial workflow proof. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  // Imports construct tagged fragments; reject only execution of those lazy fragments.
  const fragment = { then: () => { throw new Error('Unexpected financial SQL execution'); } };
  const sql = Object.assign(vi.fn(() => fragment), { unsafe: vi.fn(() => fragment) });
  return { sql, withSavepoint: (_name: string, fn: () => unknown) => fn(), withTransaction: vi.fn() };
});
vi.mock('@/lib/mcp/audit', () => ({ hashArgs: () => 'synthetic-hash', recordToolCall: vi.fn(),
  acquireIdempotencyLock: vi.fn(), findIdempotentReplay: vi.fn(async () => ({ status: 'none' })) }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool: vi.fn(async () => ({ ok: true, handle: null })), refundForTool: vi.fn() }));
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { McpRegistry } from '@/lib/mcp/registry';
import { findIdempotentReplay } from '@/lib/mcp/audit';
import { MCP_INPUT_COMPATIBILITY } from '@/lib/mcp/inputCompatibility';
import { validateToolArguments, MCP_INPUT_SCHEMA_KEYWORDS } from '@/lib/mcp/inputValidation';

interface Schema {
  type?: string | string[]; properties?: Record<string, Schema>; required?: string[];
  items?: Schema; enum?: unknown[]; minimum?: number; exclusiveMinimum?: number;
  minItems?: number; format?: string; pattern?: string;
}
interface Row { name: string; scope: string | null; write: boolean; requires_post: boolean;
  per_user_idempotency: boolean; input_schema: Record<string, unknown> }
const frozen = JSON.parse(readFileSync('docs/superpowers/plans/forensic-evidence/tool-contract-current.json', 'utf8')) as { tools: Row[] };
const UUID = '11111111-1111-4111-8111-111111111111';
function sample(schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v)]));
  if (type === 'array') return Array.from({ length: Math.max(schema.minItems ?? 1, 1) }, () => sample(schema.items!));
  if (type === 'number' || type === 'integer') return Math.max(schema.minimum ?? 1, (schema.exclusiveMinimum ?? -1) + 1);
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if(schema.pattern){
    const pattern=new RegExp(schema.pattern,'u');
    const value=['0','1.00','1234567890','001234','a'.repeat(64),UUID].find(candidate=>pattern.test(candidate));
    if(value===undefined)throw new Error(`Missing structural sample for ${schema.pattern}`);
    return value;
  }
  return schema.format === 'date' ? '2026-09-09' : UUID;
}
function requiredPaths(schema: Schema, prefix: Array<string | number> = []): Array<Array<string | number>> {
  const paths = (schema.required ?? []).map(key => [...prefix, key]);
  for (const [key, child] of Object.entries(schema.properties ?? {})) paths.push(...requiredPaths(child, [...prefix, key]));
  if (schema.items) paths.push(...requiredPaths(schema.items, [...prefix, 0]));
  return paths;
}
function without(args: Record<string, unknown>, path: Array<string | number>): Record<string, unknown> {
  const copy = structuredClone(args);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  delete parent[path[path.length - 1]!];
  return copy;
}
const context = (scopes: string[]): McpToolContext => ({ companyId: UUID, userId: 'fixture-person',
  scopes, tokenJti: UUID, oauthAppId: null });

describe('every registered tool has a frozen schema/auth fixture', () => {
  it('matches all 148 tool names and all schema keywords without silently skipping a new tool', () => {
    expect(MCP_TOOLS).toHaveLength(148);
    expect(new Set(MCP_TOOLS.map(t => t.name)).size).toBe(148);
    expect(MCP_TOOLS.map(t => t.name).sort()).toEqual(frozen.tools.map(t => t.name).sort());
    expect([...CLIENT_MCP_TOOL_NAMES].sort()).toEqual(MCP_TOOLS.map(t => t.name).sort());
    const visit = (s: Schema) => {
      for (const key of Object.keys(s)) expect(MCP_INPUT_SCHEMA_KEYWORDS).toContain(key);
      for (const child of Object.values(s.properties ?? {})) visit(child);
      if (s.items) visit(s.items);
    };
    for (const t of MCP_TOOLS) visit(t.inputSchema);
    expect(MCP_TOOLS.filter(t => t.write)).toHaveLength(68);
    expect(MCP_TOOLS.filter(t => t.requiresPost)).toHaveLength(32);
  });

  it.each(MCP_TOOLS)('$name: full structural sample, every nested required field, flags and safe containers', t => {
    const baseline = frozen.tools.find(row => row.name === t.name)!;
    expect(t.inputSchema).toEqual(baseline.input_schema);
    expect({ scope: t.scope, write: t.write, requires_post: t.requiresPost ?? false,
      per_user_idempotency: t.perUserIdempotency ?? false }).toEqual({ scope: baseline.scope, write: baseline.write,
      requires_post: baseline.requires_post, per_user_idempotency: baseline.per_user_idempotency });
    const args = sample(t.inputSchema) as Record<string, unknown>;
    expect(validateToolArguments(t, args)).toEqual({ ok: true, args });
    for (const path of requiredPaths(t.inputSchema)) expect(validateToolArguments(t, without(args, path)).ok, path.join('.')).toBe(false);
    for (const invalid of [null, [], 'invalid']) expect(validateToolArguments(t, invalid).ok).toBe(false);
    for (const field of ['approver_id', 'verified', 'role']) {
      expect(validateToolArguments(t, { ...args, [field]: 'untrusted' }).ok).toBe(false);
    }
    const properties = t.inputSchema.properties as Record<string, unknown>;
    expect(validateToolArguments(t, { ...args, dry_run: true }).ok).toBe('dry_run' in properties);
    if (t.write) {
      expect(validateToolArguments(t, { ...args, company_id: UUID }).ok).toBe(true);
      expect(validateToolArguments(t, { ...args, idempotency_key: ' ' }).ok).toBe(false);
    }
  });

  it.each(MCP_TOOLS)('$name: actual registry scope/post/idempotency fences precede synthetic handler', async t => {
    vi.mocked(findIdempotentReplay).mockResolvedValue({ status: 'none' });
    const handler = vi.fn(async (_args: Record<string, unknown>, _ctx: McpToolContext) => ({ content: [{ type: 'text' as const, text: '{"fixture":true}' }] }));
    const registry = new McpRegistry();
    // This matrix isolates registry fences; request-specific authority has separate real HTTP/PG coverage.
    registry.register({ ...t, authorize:t.authorize?vi.fn(async()=>undefined):undefined, handler } as McpTool);
    const args = sample(t.inputSchema) as Record<string, unknown>;
    const granted = [...(t.scope ? [t.scope] : []), ...(t.requiresPost ? ['write:post'] : [])];
    if (t.scope) {
      const denied = await registry.call(t.name, args, context(t.requiresPost ? ['write:post'] : []));
      expect(denied.isError).toBe(true); expect(handler).not.toHaveBeenCalled();
      expect(denied.content[0]?.type).toBe('text');
    }
    if (t.requiresPost) {
      expect((await registry.call(t.name, args, context(t.scope ? [t.scope] : []))).isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    }
    if (t.write) {
      const missing = { ...args }; delete missing.idempotency_key;
      expect((await registry.call(t.name, missing, context(granted))).isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      expect((await registry.call(t.name, { ...args, company_id: '22222222-2222-4222-8222-222222222222' }, context(granted))).isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    }
    expect((await registry.call(t.name, args, context(granted))).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[1]).toEqual(context(granted));
    if (t.write) {
      const expectedKey = t.perUserIdempotency ? `u:fixture-person:${args.idempotency_key}` : args.idempotency_key;
      expect(vi.mocked(findIdempotentReplay).mock.calls.at(-1)?.slice(0, 3)).toEqual([UUID, t.name, expectedKey]);
      vi.mocked(findIdempotentReplay).mockResolvedValue({ status: 'match', result: { content: [{ type: 'text', text: 'replay' }] } });
      expect((await registry.call(t.name, args, context(granted))).content[0]?.text).toBe('replay');
      expect(handler).toHaveBeenCalledOnce();
      vi.mocked(findIdempotentReplay).mockResolvedValue({ status: 'conflict' });
      expect((await registry.call(t.name, args, context(granted))).isError).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    }
  });
});


it('every compatibility exception identifies an existing numeric schema path', () => {
  for (const [name, compatibility] of Object.entries(MCP_INPUT_COMPATIBILITY)) {
    const registered = MCP_TOOLS.find(t => t.name === name);
    expect(registered, name).toBeDefined();
    for (const path of [...(compatibility.numeric ?? []), ...(compatibility.nullable ?? []), ...(compatibility.clamped ?? [])]) {
      let schema = registered!.inputSchema as Schema;
      for (const part of path.split('.')) schema = (part === '*' ? schema.items : schema.properties?.[part])!;
      expect(['integer', 'number'], `${name}:${path}`).toContain(schema?.type);
    }
  }
});
