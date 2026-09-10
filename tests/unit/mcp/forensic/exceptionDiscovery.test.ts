import {expect,it} from 'vitest';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
import {forensicExceptionTools} from '@/lib/mcp/tools/forensicExceptions';
it.each(forensicExceptionTools)('discovers $name once with shared authority and free control metering',tool=>{
 expect(MCP_TOOLS.filter(t=>t.name===tool.name)).toEqual([tool]);
 expect(CLIENT_MCP_TOOL_NAMES.filter(name=>name===tool.name)).toEqual([tool.name]);
 expect(tool.scope).toBe(tool.write?'write:approvals':'read:reports');
 expect(flowOperationFor(tool.name,{})).toBeNull();
});
