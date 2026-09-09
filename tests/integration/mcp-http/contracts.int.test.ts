import {expect,it} from 'vitest';
import {validateMcpHttpOrigin} from './client';
import {runMcpHttpAcceptance,sample} from './fixtures';
import {readFileSync} from 'node:fs';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
import type {McpTool} from '@/lib/mcp/types';
it('requires an explicit loopback HTTP target without credentials or redirects',()=>{
 for(const value of [undefined,'https://app.isaflow.co.za','http://127.0.0.1','http://user:secret@127.0.0.1:33219','http://127.0.0.1:33219/api/mcp','http://127.0.0.1:33219?x=1'])expect(()=>validateMcpHttpOrigin(value)).toThrow();
 expect(validateMcpHttpOrigin('http://127.0.0.1:33219')).toBe('http://127.0.0.1:33219');
});
it('verifies every declared tool structural refusal through actual local MCP HTTP',async()=>{
 const evidence=await runMcpHttpAcceptance(process.env);
 expect(evidence.toolCount).toBeGreaterThan(0);
 expect(evidence.tools).toHaveLength(evidence.toolCount);
 expect(evidence.tools.every(row=>row.inputValidation==='verified')).toBe(true);
 expect(evidence.tools.every(row=>row.scope===null||row.scopeRefusal==='verified')).toBe(true);
},600000);

it('builds required-only structural samples for all 148 current contracts without optional pattern pollution',()=>{
 const inventory=JSON.parse(readFileSync('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8')) as {tools:Array<{name:string;write:boolean;input_schema:Record<string,unknown>}>};
 expect(inventory.tools).toHaveLength(148);
 const failures:string[]=[];
 for(const tool of inventory.tools){
  const args=sample(tool.input_schema) as Record<string,unknown>;
  const result=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,args);
  if(!result.ok)failures.push(`${tool.name}: ${result.message}`);
 }
 expect(failures).toEqual([]);
 expect(sample({type:'object',properties:{cursor:{type:'string',format:'uuid'}}})).toEqual({});
});
