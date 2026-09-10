import {expect,it} from 'vitest';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
import {operationalCheckTools} from '@/lib/mcp/tools/forensicOperationalChecks';
it.each(operationalCheckTools)('registers $name exactly once as a free read',tool=>{
 expect(MCP_TOOLS.filter(t=>t.name===tool.name)).toEqual([tool]);
 expect(CLIENT_MCP_TOOL_NAMES.filter(name=>name===tool.name)).toEqual([tool.name]);
 expect(flowOperationFor(tool.name,{})).toBeNull();
});
