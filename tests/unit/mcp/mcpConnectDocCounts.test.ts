/**
 * Drift guard for docs/mcp-connect.md (FB-5). The listing copy is held to
 * "accurate, complete, and not misleading" (Cursor Marketplace Publisher Terms
 * 4.5), and the old "Read (17) / Write (8)" went stale by 140 tools. The doc
 * therefore carries no totals (they conflicted with every PR that added a tool);
 * what is held here is that every tool it names exists and that the tools it
 * calls state-changing are write tools. The read / write / write:post split is
 * held to the registry in tools-read.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-10-20'),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';

const DOC = readFileSync(join(process.cwd(), 'docs', 'mcp-connect.md'), 'utf8');

describe('docs/mcp-connect.md tool claims', () => {
  it('states no tool totals, which would conflict with every PR that adds a tool', () => {
    expect(DOC).not.toMatch(/\b\d+ tools\b|\b\d+ read-only\b/i);
  });

  it('every tool the doc names in backticks exists', () => {
    const known = new Set<string>(CLIENT_MCP_TOOL_NAMES);
    const named = [...DOC.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((x) => x[1]!);
    const notTools = new Set([
      'idempotency_key',
      'mcp_tool_calls',
      'mcp_connector',
      'dry_run',
      'is_dynamic',
      'offline_access',
    ]);
    expect(named.filter((n) => !known.has(n) && !notTools.has(n))).toEqual([]);
  });

  it('the state-changing tools the doc singles out are write tools, as it says', () => {
    for (const name of ['lock_vat_period', 'take_audit_snapshot', 'mark_vat_declared_elsewhere', 'run_depreciation']) {
      expect(MCP_TOOLS.find((t) => t.name === name)?.write, name).toBe(true);
    }
    expect(MCP_TOOLS.find((t) => t.name === 'run_depreciation')?.requiresPost).toBe(true);
  });
});
