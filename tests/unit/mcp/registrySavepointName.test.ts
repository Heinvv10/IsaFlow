// Durable invocation lifecycle is exercised separately by registryInvocation and PostgreSQL suites.
vi.mock('@/lib/mcp/invocationBoundary', () => ({ withMcpInvocation: async (_name: string, _args: unknown, run: (mark: () => void) => Promise<unknown>) => run(() => undefined) }));
/**
 * Every registered tool must produce a savepoint name `withSavepoint` accepts.
 *
 * registry.call() wraps write tools in `withSavepoint(savepointNameFor(tool))`,
 * and withSavepoint (src/lib/neon.ts) validates the name against
 * /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/ and THROWS otherwise — 31 characters, total.
 * `mcp_` + `bulk_allocate_bank_transactions` is 35, so the naive `mcp_${name}`
 * would have thrown on the very first bulk call, before the handler ran, and
 * every call would have come back as the registry's generic failure with no
 * hint that the tool name was the cause.
 *
 * Truncation is only safe while the truncated names stay distinct: two tools
 * sharing a savepoint name would let a nested call RELEASE the outer one's
 * savepoint. That uniqueness is asserted here rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { savepointNameFor } from '@/lib/mcp/registry';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

// Copied verbatim from withSavepoint in src/lib/neon.ts — the point of the
// test is that the two agree, so importing a shared constant would be circular.
const SAVEPOINT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;

describe('savepointNameFor', () => {
  it('produces a name withSavepoint accepts for every registered tool', () => {
    const rejected = MCP_TOOLS
      .map((t) => ({ tool: t.name, sp: savepointNameFor(t.name) }))
      .filter((r) => !SAVEPOINT_NAME.test(r.sp));
    expect(rejected).toEqual([]);
  });

  it('keeps the names distinct so a nested savepoint cannot release another tool\'s', () => {
    const names = MCP_TOOLS.map((t) => savepointNameFor(t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('is stable and prefixed so a savepoint is traceable to its tool', () => {
    expect(savepointNameFor('post_journal')).toBe('mcp_post_journal');
    expect(savepointNameFor('bulk_allocate_bank_transactions')).toMatch(/^mcp_bulk_allocate_bank/);
  });
});
