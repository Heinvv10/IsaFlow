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
it('verifies the selected bounded shard through actual local MCP HTTP',async()=>{
 const evidence=await runMcpHttpAcceptance(process.env);
 expect(evidence.toolCount).toBeGreaterThan(0);
 expect(evidence.executed.map(row=>row.id)).toEqual(evidence.selectedCaseIds);
 expect(evidence.executed.every(row=>row.committedRefusal)).toBe(true);
 expect(evidence.complete).toBe(evidence.executed.length===evidence.plannedCaseCount);
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

it('enumerates deterministic field refusals and explicit compatibility cases for every tool',async()=>{
 const {contractCases}=await import('./contractCases');
 const inventory=JSON.parse(readFileSync('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8'));
 const ids=new Set<string>(),failures:string[]=[];
 for(const tool of inventory.tools){
  const cases=contractCases(tool);
  expect(cases.length,tool.name).toBeGreaterThan(0);
  for(const row of cases){
   expect(ids.has(row.id),row.id).toBe(false);ids.add(row.id);
   const result=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,row.args);
   if(result.ok!==(row.kind==='compatibility'))failures.push(`${row.id}: unexpected ${JSON.stringify(result)}`);
   if(!result.ok&&result.message!==row.expected)failures.push(`${row.id}: ${result.message} != ${row.expected}`);
  }
 }
 expect(failures).toEqual([]);
 const legacy=inventory.tools.find((tool:{name:string})=>tool.name==='list_invoices');
 expect(contractCases(legacy).some(row=>row.id.includes('limit:maximum')&&row.kind==='compatibility')).toBe(true);
});

it('plans bounded refusal shards with exact static and supplemental coverage',async()=>{
 const {acceptanceCases,selectShard}=await import('./contractCases');
 const inventory=JSON.parse(readFileSync('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8'));
 const cases=acceptanceCases(inventory.tools);
 for(const [phase,count] of [['scope',145],['post',32],['current',145]] as const)expect(cases.filter(row=>row.phase===phase)).toHaveLength(count);
 expect(new Set(cases.filter(row=>row.phase==='fields').map(row=>row.tool)).size).toBe(148);
 const shards=Array.from({length:Math.ceil(cases.length/500)},(_,i)=>selectShard(cases,i,500));
 expect(shards.flat().map(row=>row.id)).toEqual(cases.map(row=>row.id));
 expect(()=>selectShard(cases,0,601)).toThrow();
});

it('requires explicitly expected correlated protocol errors',async()=>{
 const {assertRpcReply}=await import('./client');
 const reply={jsonrpc:'2.0',id:1,error:{code:-32601,message:'Method not found'}};
 expect(()=>assertRpcReply(reply,1)).toThrow();
 expect(()=>assertRpcReply(reply,1,-32601)).not.toThrow();
 expect(()=>assertRpcReply(reply,2,-32601)).toThrow();
 expect(()=>assertRpcReply({...reply,error:{code:-32603,message:'Internal error'}},1,-32601)).toThrow();
 expect(()=>assertRpcReply({jsonrpc:'2.0',id:1,result:{}},1,-32601)).toThrow();
});

it('verifies dynamic requirements and identity isolation plus real read defaults over built HTTP',async()=>{
 const {runMcpReadAcceptance}=await import('./fixtures');
 const result=await runMcpReadAcceptance(process.env);
 expect(result.identityTools).toEqual(['company_profile','list_companies']);
 expect(result.dynamicRevocation).toBe('verified');
 expect(result.identityRevocation).toBe('verified');
 expect(result.defaultRead).toEqual({tool:'list_gl_accounts',defaultRows:200,total:201,includingInactive:202,numericStringRows:3});
 expect(result.effects).toBe(0);
},120000);

it('aggregates only matching verified case IDs and reports missing shards honestly',async()=>{
 const {aggregateCoverage}=await import('./contractCases');
 const planned=[{id:'a',tool:'one',phase:'fields'},{id:'b',tool:'two',phase:'scope'}];
 const report={planHash:'hash',executed:[{...planned[0],committedRefusal:true}]};
 expect(aggregateCoverage(planned,'hash',[report])).toMatchObject({complete:false,remainingCaseIds:['b']});
 expect(()=>aggregateCoverage(planned,'hash',[{...report,planHash:'old'}])).toThrow();
 expect(()=>aggregateCoverage(planned,'hash',[{...report,executed:[{...planned[0],tool:'wrong',committedRefusal:true}]}])).toThrow();
 expect(aggregateCoverage(planned,'hash',[report,{planHash:'hash',executed:[{...planned[1],committedRefusal:true}]}])).toMatchObject({complete:true,remainingCaseIds:[]});
});
