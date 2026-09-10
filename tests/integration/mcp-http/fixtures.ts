import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {EFFECTIVE_PERMISSION_RULES} from '@/lib/auth/effectivePermissionPolicy';
import {acceptanceCases,selectShard,type GatePhase} from './contractCases';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
import {COMPANY_ASSERT_PROPERTY} from '@/lib/mcp/companyAssert';
import type {McpTool} from '@/lib/mcp/types';
import {mcpHttpClient,validateMcpHttpOrigin,verifyLocalMcpBuild,type RpcReply} from './client';
import type {Contract} from './contractSamples';
export {sample} from './contractSamples';
export interface AcceptanceOptions {phase?:GatePhase;shard?:number;size?:number;onProgress?:(evidence:unknown)=>Promise<void>}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function refusal(reply:RpcReply,expected:string,name:string,exact:boolean){
 const result=reply.result,text=result?.content?.filter(row=>row.type==='text').map(row=>row.text).join('\n')??'';
 if(result?.isError!==true||!(exact?text===expected:text.startsWith(expected)))throw new Error(`${name}: expected specific refusal, received ${text.slice(0,250)}`);
 if(/stack|SQLSTATE|postgres|SELECT |INSERT |password|token_hash/.test(text))throw new Error(`${name}: unsafe error envelope`);
}
/** Actual refusal gates only; success, defaults and financial workflows are separate evidence. */
export async function runMcpHttpAcceptance(env:NodeJS.ProcessEnv,options:AcceptanceOptions={}){
 const origin=validateMcpHttpOrigin(env.ISAFLOW_FORENSIC_HTTP_ORIGIN),config=fixtureConfigFromEnv(env);
 const target=validateFixtureTarget(config),build=await verifyLocalMcpBuild(env);
 const inventory=JSON.parse(await readFile(new URL('../../../docs/superpowers/plans/forensic-evidence/tool-contract-current.json',import.meta.url),'utf8')) as {tools:Contract[]};
 const names=inventory.tools.map(row=>row.name).sort();
 if(!names.length||new Set(names).size!==names.length)throw new Error('Invalid explicit tool contract inventory');
 const allCases=acceptanceCases(inventory.tools),planned=allCases.filter(row=>!options.phase||row.phase===options.phase);
 const cases=selectShard(planned,options.shard??0,options.size??500);
 const planHash=createHash('sha256').update(JSON.stringify(allCases)).digest('hex');
 // Validate every planned refusal before any database connection; compatibility cases never reach handlers.
 for(const row of allCases){
  const tool=inventory.tools.find(tool=>tool.name===row.tool)!;
  const validation=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,row.args);
  if(row.phase==='fields'?(validation.ok||validation.message!==row.expected):!validation.ok)throw new Error(`${row.id}: invalid acceptance case`);
 }
 const fixture=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:1,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'isaflow-mcp-contract-acceptance'});
 try{
  // Synthetic schema fixtures may omit migration506 reference data; preserve its dark default.
  await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','MCP Connector (AI agents)',false) ON CONFLICT(code) DO NOTHING");
  const feature=await pool.query("SELECT id FROM feature_flags WHERE code='mcp_connector'");
  if(feature.rows.length!==1)throw new Error('Fixture lacks committed MCP feature flag migration');
  await pool.query('INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) VALUES($1,$2,true,$3) ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true',[fixture.companyA,feature.rows[0].id,fixture.u1.id]);
  const token=fixture.u1.tokens[0]!,narrow=fixture.u1.tokens[1]!,revoked=fixture.u2.tokens[0]!;
  const modules=[...new Set(inventory.tools.flatMap(tool=>tool.scope?EFFECTIVE_PERMISSION_RULES[tool.scope]!.modules:[]))];
  for(const module of modules)await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write,can_approve) VALUES($1,$2,$3,false,false,false)',[fixture.companyA,fixture.u2.id,module]);
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
  const executed:Array<{id:string;tool:string;phase:GatePhase;committedRefusal:true}>=[];
  const progress=(outcome:'running'|'passed'='running')=>({outcome,version:2,origin,build,planHash,toolCount:names.length,fixtureRunId:fixture.runId,
   phase:options.phase??'all',shard:options.shard??0,size:options.size??500,plannedCaseCount:allCases.length,
   selectedCaseIds:cases.filter(row=>!row.sourceProof).map(row=>row.id),deferredSourceCaseIds:cases.filter(row=>row.sourceProof).map(row=>row.id),executed,remainingCaseIds:allCases.filter(row=>!executed.some(done=>done.id===row.id)).map(row=>row.id),
   complete:outcome==='passed'&&executed.length===allCases.length,
   limitations:['No valid financial execution coverage','Dynamic approval and identity cases reported separately','Compatible-input runtime defaults remain separate','No production verification']});
  let narrowMode='scope';
  for(const row of cases){
   // These gates require separate positive owned-source controls; generic refusals are not causal proof.
   if(row.sourceProof)continue;
   if((row.phase==='scope'||row.phase==='post')&&narrowMode!==row.phase){
    await pool.query('UPDATE personal_access_tokens SET scopes=$1 WHERE company_id=$2 AND user_id=$3 AND id=$4',
     [row.phase==='post'?PAT_SCOPES.filter(scope=>scope!=='write:post'):[],fixture.companyA,fixture.u1.id,narrow.id]);narrowMode=row.phase;
   }
   const selectedToken=row.phase==='current'?revoked:row.phase==='fields'?token:narrow;
   refusal(await client.rpc(selectedToken.raw,'tools/call',{name:row.tool,arguments:row.args}),row.expected,row.id,row.exact);
   const person=row.phase==='current'?fixture.u2.id:fixture.u1.id;
   const expectedCount=executed.filter(done=>done.tool===row.tool&&(done.phase==='current')===(row.phase==='current')).length+1;
   const proof=await pool.query(`SELECT count(*)::int AS count FROM mcp_invocation_attempts a
    JOIN mcp_invocation_receipts r ON r.company_id=a.company_id AND r.attempt_id=a.id
    JOIN mcp_invocation_outcomes o ON o.company_id=a.company_id AND o.attempt_id=a.id AND o.transaction_outcome='committed'
    WHERE a.company_id=$1 AND a.person_id=$2 AND a.tool=$3
     AND r.status='rejected' AND r.reported_write=false AND o.status='rejected' AND o.reported_write=false`,[fixture.companyA,person,row.tool]);
   if(proof.rows[0].count!==expectedCount)throw new Error(`${row.id}: committed refusal evidence incomplete`);
   executed.push({id:row.id,tool:row.tool,phase:row.phase,committedRefusal:true});
   await options.onProgress?.(progress());
  }
  const unchanged=await pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND user_id=$2 AND id=$3',[fixture.companyA,fixture.u2.id,revoked.id]);
  if(!same([...unchanged.rows[0].scopes].sort(),[...PAT_SCOPES].sort()))throw new Error('Current-rights test changed broad token scopes');
  return progress('passed');
 }finally{await pool.end();}
}

function dto<T>(reply:RpcReply):T{
 if(reply.result?.isError||reply.error)throw new Error('Expected successful MCP read');
 const text=reply.result?.content?.filter(row=>row.type==='text').map(row=>row.text).join('\n');
 if(!text)throw new Error('Missing MCP read body');return JSON.parse(text) as T;
}
/** Synthetic unposted source data only: no claim of controlled journal creation. */
export async function runMcpReadAcceptance(env:NodeJS.ProcessEnv){
 const origin=validateMcpHttpOrigin(env.ISAFLOW_FORENSIC_HTTP_ORIGIN),config=fixtureConfigFromEnv(env),target=validateFixtureTarget(config);
 const build=await verifyLocalMcpBuild(env);
 const fixture=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:1,connectionTimeoutMillis:3000,statement_timeout:10000,application_name:'isaflow-mcp-contract-acceptance'});
 try{
  await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','MCP Connector (AI agents)',false) ON CONFLICT(code) DO NOTHING");
  await pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[fixture.companyA,fixture.u1.id]);
  // Same human belongs to B as well; the PAT still binds reads exclusively to A.
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[fixture.companyB,fixture.u1.id]);
  const client=mcpHttpClient(origin),token=fixture.u1.tokens[0]!;
  await client.rpc(token.raw,'forensic_unknown_method',{},-32601);
  await client.expectedHttp(401,'pat_invalid_synthetic_token',{jsonrpc:'2.0',id:1,method:'tools/list'});
  const profile=dto<{name:string}>(await client.rpc(token.raw,'tools/call',{name:'company_profile',arguments:{}}));
  const companies=dto<{companies:Array<{company_id:string;name:string}>;total:number}>(await client.rpc(token.raw,'tools/call',{name:'list_companies',arguments:{}}));
  if(profile.name!==`Forensic A ${fixture.runId}`||companies.total!==1||companies.companies.length!==1||companies.companies[0]?.company_id!==fixture.companyA)throw new Error('Bound-company identity read mismatch');
  const ids=Array.from({length:202},()=>randomUUID()),period=randomUUID(),journal=randomUUID();
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
   SELECT id,$2,'HTTP-'||lpad(n::text,4,'0'),'HTTP accounting source','asset','debit',3,n<202 FROM unnest($1::uuid[]) WITH ORDINALITY source(id,n)`,[ids,fixture.companyA]);
  await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,'HTTP-foreign','HTTP accounting source','asset','debit',3,true)",[randomUUID(),fixture.companyB]);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
   VALUES($1,$2,'HTTP source period',1,2026,'2026-09-01','2026-09-30','open')`,[period,fixture.companyA]);
  await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by)
   VALUES($1,$2,'2026-09-09',$3,'manual','draft',$4)`,[journal,fixture.companyA,period,fixture.u1.id]);
  await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
   VALUES($1,$2,$3,10,0),($1,$2,$4,0,10)`,[journal,fixture.companyA,ids[0],ids[1]]);
  type Page={accounts:Array<{id:string}>;total:number;next_cursor:string|null};
  const read=async(args:Record<string,unknown>)=>dto<Page>(await client.rpc(token.raw,'tools/call',{name:'list_gl_accounts',arguments:{search:'HTTP accounting source',...args}}));
  const first=await read({}),last=await read({cursor:first.next_cursor}),all=await read({active_only:false,limit:500}),numeric=await read({limit:'3'});
  if(first.accounts.length!==200||first.total!==201||!first.next_cursor||last.accounts.length!==1||last.next_cursor!==null||all.accounts.length!==202||numeric.accounts.length!==3)throw new Error('Actual default/pagination compatibility mismatch');
  if(!same([...first.accounts,...last.accounts].map(row=>row.id).sort(),ids.slice(0,201).sort())||!same(all.accounts.map(row=>row.id).sort(),[...ids].sort()))throw new Error('Actual read population or ownership mismatch');
  const args={operation:'journal.post',entity_type:'journal_entry',entity_id:journal};
  const before=dto<{amount:string}>(await client.rpc(token.raw,'tools/call',{name:'approval_requirements',arguments:args}));
  if(Number(before.amount)!==10)throw new Error('Owned draft requirements did not load exact amount');
  await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[fixture.companyA,fixture.u1.id]);
  refusal(await client.rpc(token.raw,'tools/call',{name:'approval_requirements',arguments:args}),'The operation failed. Please try again or contact support.','dynamic requirements after current deny',true);
  await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u1.id]);
  const restored=dto<{amount:string}>(await client.rpc(token.raw,'tools/call',{name:'approval_requirements',arguments:args}));
  if(!same(restored,before))throw new Error('Dynamic deny control did not restore same unchanged source result');
  const proof=await pool.query(`SELECT (SELECT count(*)::int FROM control_operation_effects WHERE company_id=$1) AS effects,
   (SELECT count(*)::int FROM control_operation_approvals WHERE company_id=$1) AS approvals,
   (SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2) AS status,
   (SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND user_id=$3 AND id=$4) AS scopes`,[fixture.companyA,journal,fixture.u1.id,token.id]);
  if(proof.rows[0].effects!==0||proof.rows[0].approvals!==0||proof.rows[0].status!=='draft'||!same([...proof.rows[0].scopes].sort(),[...PAT_SCOPES].sort()))throw new Error('Read-only dynamic control changed effects or token scopes');
  await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u1.id]);
  for(const name of ['company_profile','list_companies'])await client.expectedHttp(403,token.raw,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}});
  return{outcome:'passed',version:1,origin,build,fixtureRunId:fixture.runId,identityRevocation:'verified',identityTools:['company_profile','list_companies'],dynamicRevocation:'verified',effects:0,
   defaultRead:{tool:'list_gl_accounts',defaultRows:200,total:201,includingInactive:202,numericStringRows:3},
   limitations:['Draft journal and accounts are synthetic source fixtures, not controlled creation/posting proof','Dynamic refusal is a generic public handler envelope with successful before/after controls','No financial execution or production verification']};
 }finally{await pool.end();}
}
