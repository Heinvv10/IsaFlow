/**
 * What /api/mcp says about itself: the `initialize` result, the
 * `server/discover` result, and the human-readable GET document. Moved out of
 * pages/api/mcp/index.ts so the route stays under 300 lines (FB-3).
 *
 * `server/discover` (MCP 2026-07-28, server/discover) is answered with a small
 * static DiscoverResult that lists only MCP_PROTOCOL_VERSION (2025-06-18).
 * This server is legacy-era (initialize handshake); listing only a legacy
 * version tells a dual-era client to use `initialize`, where it used to get
 * -32601 at HTTP 200, which a 2026-07-28 client reads as neither era. The
 * stateless 2026-07-28 protocol itself (per-request `_meta`, header
 * validation, UnsupportedProtocolVersionError) is NOT implemented here.
 */
import { MCP_PROTOCOL_VERSION } from './jsonrpc';
import {
  CLIENT_MCP_TOOL_NAMES,
  MCP_AUTH_SERVER_METADATA_PATH,
  MCP_PATH,
  MCP_PROD_ENDPOINT,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
  appOrigin,
  serverIcons,
} from './clientMetadata';

const SERVER_NAME = 'isaflow';
const SERVER_VERSION = '1.0.0';
const SERVER_TITLE = 'IsaFlow Accounting';
const TOOLS_CAPABILITY = { tools: { listChanged: false } };

function serverInfo() {
  return { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE, icons: serverIcons() };
}

export function initializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: serverInfo(),
    capabilities: TOOLS_CAPABILITY,
  };
}

export function discoverResult() {
  return {
    resultType: 'complete',
    supportedVersions: [MCP_PROTOCOL_VERSION],
    capabilities: TOOLS_CAPABILITY,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

/** The unauthenticated GET document for people and docs (not an MCP message). */
export function serverInfoDocument() {
  const origin = appOrigin();
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'http-jsonrpc',
    endpoint: `${origin}${MCP_PATH}`,
    productionEndpoint: MCP_PROD_ENDPOINT,
    auth: {
      type: 'bearer',
      description:
        'Connect with the browser OAuth flow (recommended) or a personal access token (pat_...).',
      authorizationServer: `${origin}${MCP_AUTH_SERVER_METADATA_PATH}`,
      protectedResource: `${origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}`,
    },
    tools: CLIENT_MCP_TOOL_NAMES,
  };
}
