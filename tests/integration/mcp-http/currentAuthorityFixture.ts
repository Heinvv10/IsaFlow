/** Causal current-rights proof: real owned sources, real issued BearerAuth, no financial execution. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {mcpHttpClient,validateMcpHttpOrigin,verifyLocalMcpBuild,type RpcReply} from './client';
import {acceptanceCases} from './contractCases';
import type {Contract} from './contractSamples';
function value<T>(reply:RpcReply):T{
 if(reply.error||reply.result?.isError)throw new Error('Positive owned-source control refused');
 return JSON.parse(reply.result?.content?.map(row=>row.text??'').join('\n')??'') as T;
}
export async function runCurrentSourceAcceptance(env:NodeJS.ProcessEnv){
 const origin=validateMcpHttpOrigin(env.ISAFLOW_FORENSIC_HTTP_ORIGIN),build=await verifyLocalMcpBuild(env);
 const config=fixtureConfigFromEnv(env),target=validateFixtureTarget(config),fixture=await provisionForensicFixture(config);
 const {withBearerAuth}=await import('@/lib/auth/withBearerAuth');
 const {MCP_TOOLS}=await import('@/lib/mcp/toolIndex');
 const {runAuditJob}=await import('@/modules/accounting/services/controls/auditJobRunner');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000,connectionTimeoutMillis:3000});
 const approvedArgs=new Map<string,Record<string,unknown>>();
 const handler=withBearerAuth(async(req,res)=>{
  const name=String(req.body?.name),args=approvedArgs.get(name),tool=MCP_TOOLS.find(row=>row.name===name);
  if(!args||!tool?.authorize||req.companyId!==fixture.companyA||req.user.id!==fixture.u2.id){res.status(400).json({authorized:false});return;}
  await tool.authorize(args,{companyId:req.companyId,userId:req.user.id,scopes:req.scopes??[],tokenJti:req.patId??req.oauthAuthorisationId??null,oauthAppId:req.oauthAppId??null});
  res.status(200).json({authorized:true,name});
 });
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/forensic-authorize-probe').catch(()=>{res.statusCode=500;res.end('Authorization probe failed');});});
 let failed=false;
 try{
  await listenCurrentAuthorityProbe(server);
  const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback probe unavailable');
  await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
  await pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[fixture.companyA,fixture.u2.id]);
  const journal=randomUUID(),period=randomUUID(),accounts=[randomUUID(),randomUUID()];
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Causal HTTP source',1,2026,'2026-09-01','2026-09-30','open')",[period,fixture.companyA]);
  for(const id of accounts)await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Causal source account','asset','debit',3,true)",[id,fixture.companyA]);
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by) VALUES($1,$2,'2026-09-09',$3,'manual','draft',$4)",[journal,fixture.companyA,period,fixture.u2.id]);
  await pool.query('INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,10,0),($1,$2,$4,0,10)',[journal,fixture.companyA,...accounts]);
  const client=mcpHttpClient(origin),token=fixture.u2.tokens[0]!;
  const scopes=(await pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND user_id=$2 AND id=$3',[fixture.companyA,fixture.u2.id,token.id])).rows[0].scopes;
  const job=value<{id:string}>(await client.rpc(token.raw,'tools/call',{name:'audit_snapshot',arguments:{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:randomUUID()}}));
  const run=await runAuditJob({companyId:fixture.companyA,personId:fixture.u2.id,jobId:job.id},{pool});
  if(run.state!=='succeeded')throw new Error(`Real snapshot prerequisite failed: ${run.state}`);
  value(await client.rpc(token.raw,'tools/call',{name:'audit_snapshot_manifest',arguments:{snapshot_id:job.id}}));
  approvedArgs.set('export_audit_evidence',{snapshot_id:job.id,idempotency_key:randomUUID()});
  const journalRef={operation:'journal.post',entity_type:'journal_entry',entity_id:journal};
  const requirements=value<{amount:string}>(await client.rpc(token.raw,'tools/call',{name:'approval_requirements',arguments:journalRef}));
  if(Number(requirements.amount)!==10)throw new Error('Actual owned draft read did not verify exact amount');
  approvedArgs.set('request_operation_approval',{...journalRef,idempotency_key:randomUUID()});
  const inventory=JSON.parse(await readFile('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8')) as {tools:Contract[]};
  const cases=acceptanceCases(inventory.tools),executed=[];
  for(const row of cases.filter(row=>row.sourceProof)){
   const boundArgs=approvedArgs.get(row.tool)!;
   const positive=await fetch(`http://127.0.0.1:${address.port}/api/forensic-authorize-probe`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token.raw}`,'content-type':'application/json'},body:JSON.stringify({name:row.tool})});
   if(positive.status!==200||(await positive.json() as {authorized?:boolean}).authorized!==true)throw new Error(`${row.id}: actual issued positive authorization failed`);
   await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write,can_approve) VALUES($1,$2,'reports',false,false,false)",[fixture.companyA,fixture.u2.id]);
   try{
    const negative=await client.rpc(token.raw,'tools/call',{name:row.tool,arguments:boundArgs});
    if(negative.result?.isError!==true||negative.result.content?.map(item=>item.text??'').join('\n')!==row.expected)throw new Error(`${row.id}: actual built current denial failed`);
   }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u2.id]);}
   const current=(await pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND user_id=$2 AND id=$3',[fixture.companyA,fixture.u2.id,token.id])).rows[0].scopes;
   if(JSON.stringify(current)!==JSON.stringify(scopes))throw new Error('Current denial altered PAT scopes');
   const receipt=await pool.query("SELECT count(*)::int AS count FROM mcp_invocation_attempts a JOIN mcp_invocation_receipts r ON r.company_id=a.company_id AND r.attempt_id=a.id JOIN mcp_invocation_outcomes o ON o.company_id=a.company_id AND o.attempt_id=a.id WHERE a.company_id=$1 AND a.person_id=$2 AND a.tool=$3 AND r.status='rejected' AND r.reported_write=false AND o.status='rejected' AND o.transaction_outcome='committed'",[fixture.companyA,fixture.u2.id,row.tool]);
   if(receipt.rows[0].count!==1)throw new Error('Missing committed causal refusal receipt');
   executed.push({id:row.id,tool:row.tool,phase:row.phase,committedRefusal:true,causalProof:{kind:row.sourceProof,positiveAuthorized:true,unchangedToken:true,boundArgs}});
  }
  const effects=await pool.query("SELECT (SELECT count(*)::int FROM control_operation_effects WHERE company_id=$1) AS effects,(SELECT count(*)::int FROM control_operation_approvals WHERE company_id=$1) AS approvals,(SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2) AS status,(SELECT count(*)::int FROM control_audit_jobs WHERE company_id=$1) AS jobs",[fixture.companyA,journal]);
  if(effects.rows[0].effects!==0||effects.rows[0].approvals!==0||effects.rows[0].status!=='draft'||effects.rows[0].jobs!==1)throw new Error('Causal probe created an unrequested effect, approval or export job');
  return{outcome:'passed',build,planHash:createHash('sha256').update(JSON.stringify(cases)).digest('hex'),executed,effects:0,fixtureRunId:fixture.runId,limitations:['Positive authorize runs through real issued BearerAuth in a fixture-only probe; negative executes built MCP HTTP','Draft journal is synthetic unposted source, not controlled creation proof','Snapshot is created by real enqueue and runner; no export or financial execution','No production verification']};
 }catch(error){failed=true;throw error;}finally{
  await closeCurrentAuthorityResources([
   async()=>{if(server.listening)await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});},
   async()=>{await (await import('@/lib/auth/authPool')).getAuthPool().end();},
   async()=>{await (await import('@/lib/neon')).getPoolForTests().end();},
   async()=>{await pool.end();},
  ],failed);
 }
}
/** Every resource gets a close attempt; cleanup cannot replace the original failure. */
export async function closeCurrentAuthorityResources(closers:Array<()=>Promise<void>>,originalFailed:boolean){
 const results=await Promise.allSettled(closers.map(async close=>close()));
 const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
 if(failures.length&&!originalFailed)throw new AggregateError(failures.map(row=>row.reason),'Causal fixture resource cleanup failed');
}

export async function listenCurrentAuthorityProbe(server:Server,port=0){
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
}
