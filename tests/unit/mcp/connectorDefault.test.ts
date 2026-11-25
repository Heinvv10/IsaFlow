/** The MCP connector default-on helper (migration 1056): one statement, the caller's ids, the function's answer. */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));

import {
  ENABLE_MCP_DEFAULT_SQL,
  MCP_DEFAULT_ON_REASON,
  enableMcpConnectorDefault,
  enableMcpConnectorDefaultViaSql,
} from '@/lib/mcp/connectorDefault';

beforeEach(() => { sqlMock.mockReset(); });

describe('enableMcpConnectorDefault', () => {
  it('sends exactly the default-on SQL with [companyId, actorId] and returns its boolean', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ enabled: true }] });
    await expect(enableMcpConnectorDefault({ query }, 'co-1', 'user-1')).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(ENABLE_MCP_DEFAULT_SQL, ['co-1', 'user-1']);
    expect(ENABLE_MCP_DEFAULT_SQL).toBe('SELECT public.enable_mcp_connector_default($1::uuid, $2::uuid) AS enabled');
  });

  it('returns false when the function wrote nothing (older company, existing row)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ enabled: false }] });
    await expect(enableMcpConnectorDefault({ query }, 'co-1', 'user-1')).resolves.toBe(false);
  });

  it("keeps the reason the migration's rollback deletes by", () => {
    expect(MCP_DEFAULT_ON_REASON).toBe('Default on for new companies');
  });
});

describe('enableMcpConnectorDefaultViaSql', () => {
  it('calls enable_mcp_connector_default with the company and actor bound, not concatenated', async () => {
    sqlMock.mockResolvedValue([{ enabled: true }]);
    await expect(enableMcpConnectorDefaultViaSql('co-2', 'admin-1')).resolves.toBe(true);
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join('?')).toContain('public.enable_mcp_connector_default(');
    expect(values).toEqual(['co-2', 'admin-1']);
  });
});
