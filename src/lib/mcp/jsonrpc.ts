/**
 * JSON-RPC 2.0 envelope helpers for the MCP transport (pages/api/mcp).
 * Pure functions — no I/O, no framework imports.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000, // rate limit
  NOT_ENABLED: -32001, // mcp_connector feature flag off
} as const;

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** A JSON-RPC notification: no id → the server sends no response entry. */
export function isNotification(rpc: JsonRpcRequest): boolean {
  return rpc.id === undefined || rpc.id === null;
}
