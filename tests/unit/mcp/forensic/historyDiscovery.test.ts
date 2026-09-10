import {expect,it} from 'vitest';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
import {forensicHistoryTools} from '@/lib/mcp/tools/forensicHistory';
it.each(forensicHistoryTools)('registers $name once with shared source authority and free read metering',tool=>{
 expect(MCP_TOOLS.filter(t=>t.name===tool.name)).toEqual([tool]);
 expect(CLIENT_MCP_TOOL_NAMES.filter(name=>name===tool.name)).toEqual([tool.name]);
 expect(tool.write).toBe(false);expect(tool.scope).toBe(tool.name==='transaction_evidence_chain'?null:'read:audit');
 expect(flowOperationFor(tool.name,{})).toBeNull();
});
