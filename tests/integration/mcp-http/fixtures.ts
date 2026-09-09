import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
import {COMPANY_ASSERT_PROPERTY} from '@/lib/mcp/companyAssert';
import type {McpTool} from '@/lib/mcp/types';
import {mcpHttpClient,validateMcpHttpOrigin,type RpcReply} from './client';
interface Contract {name:string;scope:string|null;write:boolean;requires_post:boolean;input_schema:Record<string,unknown>}
interface Schema {type?:string|string[];properties?:Record<string,Schema>;items?:Schema;enum?:unknown[];minimum?:number;exclusiveMinimum?:number;minItems?:number;format?:string}
export interface ToolEvidence {name:string;scope:string|null;inputValidation:'verified';scopeRefusal:'verified'|'not_applicable';committedRefusals:number}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function sample(schema:Schema):unknown{
 if(schema.enum)return schema.enum[0];
 const type=Array.isArray(schema.type)?schema.type[0]:schema.type;
 if(type==='object')return Object.fromEntries(Object.entries(schema.properties??{}).map(([key,value])=>[key,sample(value)]));
 if(type==='array')return Array.from({length:Math.max(schema.minItems??1,1)},()=>sample(schema.items!));
 if(type==='number'||type==='integer')return Math.max(schema.minimum??1,(schema.exclusiveMinimum??-1)+1);
 if(type==='boolean')return false;if(type==='null')return null;
 return schema.format==='date'?'2026-09-09':'11111111-1111-4111-8111-111111111111';
}
function refusal(reply:RpcReply,expected:RegExp,name:string){
 const result=reply.result,text=result?.content?.filter(row=>row.type==='text').map(row=>row.text).join('\n')??'';
 if(result?.isError!==true||!expected.test(text))throw new Error(`${name}: expected specific refusal, received ${text.slice(0,250)}`);
 if(/stack|SQLSTATE|postgres|SELECT |INSERT |password|token_hash/.test(text))throw new Error(`${name}: unsafe error envelope`);
}
/** Initial gate coverage only: no successful financial handler or current-authority claim. */
export async function runMcpHttpAcceptance(env:NodeJS.ProcessEnv){
 const origin=validateMcpHttpOrigin(env.ISAFLOW_FORENSIC_HTTP_ORIGIN),config=fixtureConfigFromEnv(env);
 const target=validateFixtureTarget(config);
 const inventory=JSON.parse(await readFile(new URL('../../../docs/superpowers/plans/forensic-evidence/tool-contract-current.json',import.meta.url),'utf8')) as {tools:Contract[]};
 const names=inventory.tools.map(row=>row.name).sort();
 if(!names.length||new Set(names).size!==names.length)throw new Error('Invalid explicit tool contract inventory');
 // Validate samples before connecting, without invoking a handler or auth service.
 const samples=new Map<string,Record<string,unknown>>();
 for(const tool of inventory.tools){
  const args=sample(tool.input_schema) as Record<string,unknown>;
  if(tool.write)args.idempotency_key=randomUUID();
  const validation=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,args);
  if(!validation.ok)throw new Error(`${tool.name}: explicit structural sample gap: ${validation.message}`);
  samples.set(tool.name,args);
 }
 const fixture=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
 try{
  // Synthetic schema fixtures may omit migration506 reference data; preserve its dark default.
  await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','MCP Connector (AI agents)',false) ON CONFLICT(code) DO NOTHING");
  const feature=await pool.query("SELECT id FROM feature_flags WHERE code='mcp_connector'");
  if(feature.rows.length!==1)throw new Error('Fixture lacks committed MCP feature flag migration');
  await pool.query('INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) VALUES($1,$2,true,$3) ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true',[fixture.companyA,feature.rows[0].id,fixture.u1.id]);
  const token=fixture.u1.tokens[0]!,narrow=fixture.u1.tokens[1]!;
  await pool.query('UPDATE personal_access_tokens SET scopes=ARRAY[]::text[] WHERE company_id=$1 AND user_id=$2 AND id=$3',[fixture.companyA,fixture.u1.id,narrow.id]);
  const client=mcpHttpClient(origin),discovery=await client.get();
  if(!same([...discovery.tools].sort(),names))throw new Error('Unauthenticated discovery inventory differs from named contract');
  const initialized=await client.rpc(token.raw,'initialize');
  if(initialized.result?.serverInfo?.name!=='isaflow')throw new Error('Unexpected MCP initialize server');
  const manifest=(await client.rpc(token.raw,'tools/list')).result?.tools;
  if(!manifest||!same(manifest.map(row=>row.name).sort(),names))throw new Error('Authenticated manifest inventory differs from named contract');
  for(const tool of inventory.tools){
   const actual=manifest.find(row=>row.name===tool.name)!;
   const expected=tool.write?{...tool.input_schema,properties:{...tool.input_schema.properties as object,...COMPANY_ASSERT_PROPERTY}}:tool.input_schema;
   if(!same(actual.inputSchema,expected))throw new Error(`${tool.name}: manifest schema drift`);
  }
  const tools:ToolEvidence[]=[];
  for(const tool of inventory.tools){
   const args=samples.get(tool.name)!;
   // Always an extra field: even tools with no required fields cannot reach handlers.
   refusal(await client.rpc(token.raw,'tools/call',{name:tool.name,arguments:{...args,forensic_untrusted_authority:true}}),/unsupported properties/,tool.name);
   if(tool.scope)refusal(await client.rpc(narrow.raw,'tools/call',{name:tool.name,arguments:args}),new RegExp(`Insufficient scope: this tool requires ${tool.scope.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`),tool.name);
   const expectedCount=tool.scope?2:1;
   const proof=await pool.query(`SELECT count(*)::int AS count FROM mcp_invocation_attempts a
    JOIN mcp_invocation_receipts r ON r.company_id=a.company_id AND r.attempt_id=a.id
    JOIN mcp_invocation_outcomes o ON o.company_id=a.company_id AND o.attempt_id=a.id AND o.transaction_outcome='committed'
    WHERE a.company_id=$1 AND a.person_id=$2 AND a.tool=$3
     AND r.status='rejected' AND r.reported_write=false AND o.status='rejected' AND o.reported_write=false`,[fixture.companyA,fixture.u1.id,tool.name]);
   if(proof.rows[0].count!==expectedCount)throw new Error(`${tool.name}: committed refusal evidence incomplete`);
   tools.push({name:tool.name,scope:tool.scope,inputValidation:'verified',scopeRefusal:tool.scope?'verified':'not_applicable',committedRefusals:expectedCount});
  }
  return{version:1,origin,toolCount:names.length,fixtureRunId:fixture.runId,tools,
   limitations:['No valid financial execution coverage','No current permission revocation coverage','No write-post-only scope coverage','No per-field invalid matrix coverage','No production verification']};
 }finally{await pool.end();}
}
