/** Export declarations only: importing tools never executes a tool handler. */
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {MCP_TOOLS} from '../../src/lib/mcp/toolIndex';
const tools=MCP_TOOLS.map(tool=>({name:tool.name,scope:tool.scope,write:tool.write,
 requires_post:tool.requiresPost??false,per_user_idempotency:tool.perUserIdempotency??false,input_schema:tool.inputSchema}))
 .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
writeFileSync(resolve('docs/superpowers/plans/forensic-evidence/tool-contract-current.json'),JSON.stringify({
 schemaVersion:1,method:'Runtime executable declarations; no handlers executed. This is a contract baseline, not workflow or authorization proof.',
 historicalInventory:'tool-matrix.json',counts:{total:tools.length,reads:tools.filter(t=>!t.write).length,
 writes:tools.filter(t=>t.write).length,requires_post:tools.filter(t=>t.requires_post).length},tools},null,2)+'\n');
