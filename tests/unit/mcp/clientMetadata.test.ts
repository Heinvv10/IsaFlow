/**
 * Drift guard — CLIENT_MCP_TOOL_NAMES (zero-import, client-bundle safe) must
 * exactly match the registered tool set in toolIndex.ts. MCP Phase 2, Task 2.6.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-07-19'),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { CLIENT_MCP_TOOL_NAMES, MCP_PATH, MCP_PROD_ENDPOINT } from '@/lib/mcp/clientMetadata';
import { mcpRegistry } from '@/lib/mcp/toolIndex';

describe('clientMetadata drift guard', () => {
  it('discovers queued forensic work and bounded retained delivery', () => {
    const registered = mcpRegistry.getManifest().map(tool => tool.name);
    expect(registered).toEqual(expect.arrayContaining(['audit_snapshot','export_audit_evidence','audit_job_status',
      'audit_snapshot_manifest','audit_snapshot_items','audit_snapshot_chunk','audit_export_files','audit_export_chunk']));
  });
  it('CLIENT_MCP_TOOL_NAMES exactly matches the registered tools', () => {
    const registered = mcpRegistry.getManifest().map((t) => t.name).sort();
    expect([...CLIENT_MCP_TOOL_NAMES].sort()).toEqual(registered);
  });

  it('endpoint constants are consistent', () => {
    expect(MCP_PROD_ENDPOINT.endsWith(MCP_PATH)).toBe(true);
  });
});

it('discovers the complete attended approval, beneficiary and bank command entry points',()=>{
 const names=['approval_requirements','request_operation_approval','list_pending_approvals','propose_supplier_bank_change','supplier_bank_change_status','prepare_bank_operation','execute_bank_operation'];
 const registered=mcpRegistry.getManifest().map(tool=>tool.name);
 for(const name of names){expect(registered).toContain(name);expect(CLIENT_MCP_TOOL_NAMES).toContain(name);}
});
