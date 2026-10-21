/**
 * Drift guard for docs/mcp-connect.md (FB-5). The listing copy is held to
 * "accurate, complete, and not misleading" (Cursor Marketplace Publisher Terms
 * 4.5), and the old "Read (17) / Write (8)" went stale by 140 tools. The doc's
 * one count line is checked against the registry here, the same pattern as
 * clientMetadata.test.ts checks CLIENT_MCP_TOOL_NAMES.
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
const COUNT_LINE = /\*\*(\d+) tools\*\* \((\d+) read-only, (\d+) that change data; (\d+) of those also need `write:post`\)/;

describe('docs/mcp-connect.md tool counts', () => {
  it('states the registry\'s own counts', () => {
    const m = DOC.match(COUNT_LINE);
    expect(m, 'count line missing from docs/mcp-connect.md').not.toBeNull();
    const [, total, read, write, post] = m!.map(Number);
    expect({ total, read, write, post }).toEqual({
      total: MCP_TOOLS.length,
      read: MCP_TOOLS.filter((t) => !t.write).length,
      write: MCP_TOOLS.filter((t) => t.write).length,
      post: MCP_TOOLS.filter((t) => t.requiresPost).length,
    });
    expect(total).toBe(CLIENT_MCP_TOOL_NAMES.length);
  });

  it('every tool the doc names in backticks exists', () => {
    const known = new Set<string>(CLIENT_MCP_TOOL_NAMES);
    const named = [...DOC.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((x) => x[1]!);
    const notTools = new Set(['idempotency_key', 'mcp_tool_calls', 'mcp_connector', 'dry_run', 'is_dynamic']);
    expect(named.filter((n) => !known.has(n) && !notTools.has(n))).toEqual([]);
  });

  it('the state-changing tools the doc singles out are write tools, as it says', () => {
    for (const name of ['lock_vat_period', 'take_audit_snapshot', 'mark_vat_declared_elsewhere', 'run_depreciation']) {
      expect(MCP_TOOLS.find((t) => t.name === name)?.write, name).toBe(true);
    }
    expect(MCP_TOOLS.find((t) => t.name === 'run_depreciation')?.requiresPost).toBe(true);
  });
});
