import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';

/**
 * POST /api/mcp (tools/call: create_draft_journal, post_journal) over real HTTP, so a lockdown or closed-period
 * refusal is answered the way bearerPipeline.ts actually answers it — the SAME controlWriteFailed-then-500
 * CONTROL_INTEGRITY_FAILED override withAuth.ts uses for the REST routes — not the way postJournalTool's handler
 * throws in isolation.
 */
export async function writeJournalsLockdownFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY??=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY??=randomBytes(32).toString('hex');
 const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
 let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([pool.end(),import('@/lib/mcp/invocationStore').then(m=>m.closeInvocationPool()),
   import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic MCP journal cleanup failed');
 }
 try{
  const f=await provisionForensicFixture(config),periodId=randomUUID(),accounts=[randomUUID(),randomUUID()];
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false,lockdown_date=null WHERE id=$1",[f.companyA]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic MCP journal September',9,2026,'2026-09-01','2026-09-30','open')",[periodId,f.companyA]);
  for(const [i,account] of accounts.entries())await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,$3,$4,$5,$6,3,true)",[account,f.companyA,account.slice(0,12),`Synthetic MCP journal account ${i}`,i?'liability':'asset',i?'credit':'debit']);
  await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
  await pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[f.companyA,f.u1.id]);
  const lockdown=(enabled:boolean,date:string|null=null)=>pool.query('UPDATE companies SET lockdown_enabled=$1,lockdown_date=$2 WHERE id=$3',[enabled,date,f.companyA]);
  const status=async(id:string)=>(await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0]?.status as string|undefined;
  const {mcpRegistry}=await import('@/lib/mcp/toolIndex');
  const route=(await import('../../../pages/api/mcp/index')).default;
  server=createServer((req,res)=>{void apiResolver(req,res,{},{default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/mcp')
   .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic MCP journal REST failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic MCP journal listener missing');
  const origin=`http://127.0.0.1:${address.port}`;
  let sequence=0;
  async function call(name:string,args:Record<string,unknown>){
   const id=++sequence;
   const response=await fetch(`${origin}/api/mcp`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json',Authorization:`Bearer ${f.u1.tokens[0]!.raw}`},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
   const json=await response.json() as {result?:{isError?:boolean;content?:Array<{type:string;text:string}>};error?:{code:number;message:string}};
   return{status:response.status,isError:json.result?.isError===true,
    text:json.result?.content?.map(item=>item.text).join('\n')??'',protocolError:json.error?.message};
  }
  return{f,pool,periodId,accounts,lockdown,status,call,registeredTools:mcpRegistry.listTools().map(t=>t.name),close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic MCP journal setup failed');}throw error;}
}
