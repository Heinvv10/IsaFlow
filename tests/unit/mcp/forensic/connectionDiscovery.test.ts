import {expect,it} from 'vitest';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
import {connectionPermissionsTool} from '@/lib/mcp/tools/forensicAccess';
it('discovers self permission inspection without a read-access scope or billing charge',()=>{
 expect(MCP_TOOLS.filter(t=>t.name==='connection_permissions')).toEqual([connectionPermissionsTool]);
 expect(CLIENT_MCP_TOOL_NAMES.filter(name=>name==='connection_permissions')).toEqual(['connection_permissions']);
 expect(connectionPermissionsTool.scope).toBeNull();expect(connectionPermissionsTool.write).toBe(false);
 expect(flowOperationFor('connection_permissions',{})).toBeNull();
});
