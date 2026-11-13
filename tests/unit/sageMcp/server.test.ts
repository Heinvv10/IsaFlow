/** Sage MCP stdio server: protocol handshake, read-only annotations, config errors surfaced per call. */
import { describe, it, expect, vi } from 'vitest';
import { handleMessage, PROTOCOL_VERSION, type Deps } from '../../../packages/sage-readonly-mcp/src/server';
import type { SageClient } from '../../../packages/sage-readonly-mcp/src/client';

const client = { get: vi.fn(async () => ({ ID: 1 })), list: vi.fn(), download: vi.fn() } as unknown as SageClient;
const deps: Deps = { client, downloadDir: '/tmp/unused' };

describe('sage mcp server', () => {
  it('answers initialize with the protocol version and tools capability', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps);
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} } } });
  });

  it('lists every tool as read-only and non-destructive', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    const tools = (r!.result as { tools: Array<{ annotations: Record<string, boolean> }> }).tools;
    expect(tools).toHaveLength(5);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('calls a tool', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sage_get_document', arguments: { type: 'siv', id: 1 } } }, deps);
    expect(JSON.parse((r!.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual({ resource: 'SupplierInvoice', document: { ID: 1 } });
  });

  it('returns the configuration error on every call when the env file is missing or unsafe', async () => {
    const r = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sage_list', arguments: { service: 'Supplier' } } },
      { configError: 'No Sage env file at /x. Copy sage-env.template there and fill it in.' },
    );
    expect(r!.result).toEqual({ content: [{ type: 'text', text: 'No Sage env file at /x. Copy sage-env.template there and fill it in.' }], isError: true });
  });

  it('a notification gets no reply; an unknown request gets -32601', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, deps)).toMatchObject({ error: { code: -32601 } });
  });
});
