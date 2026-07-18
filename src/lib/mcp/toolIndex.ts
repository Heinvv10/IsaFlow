/**
 * Assembles MCP_TOOLS into the singleton registry the transport dispatches
 * through. Read tools register here (Task 2.6); write/post tools append in
 * Phase 3. The drift-guard test keeps CLIENT_MCP_TOOL_NAMES in sync.
 */
import { McpRegistry } from './registry';

export const mcpRegistry = new McpRegistry();
