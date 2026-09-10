import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
export async function auditComparisonRestFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([pool.end(),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic comparison REST cleanup failed');
 }
 try{
 const f=await provisionForensicFixture(config);
 const {withAuditWorkerTransaction}=await import('@/modules/accounting/services/controls/auditWorkerTransaction');
 const {withControlRequest,requireControlTx}=await import('@/modules/accounting/services/controls/context');
 const {enqueueAuditSnapshot}=await import('@/modules/accounting/services/controls/auditJobService');
 const {runAuditSnapshotJob,runAuditJob}=await import('@/modules/accounting/services/controls/auditJobRunner');
 const snapshots:string[]=[],records=[randomUUID(),randomUUID()];
 for(let index=0;index<2;index++){
  if(index)await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[records,f.companyA,f.u1.id]);
  const job=await withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f.u1.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
   store=>withControlRequest(store,{companyId:f.companyA,personId:f.u1.id,authMethod:'cookie'},()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()})));
  if((await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).state!=='succeeded')throw new Error('Synthetic source snapshot worker failed');snapshots.push(job.id);
 }
 const handler=(await import('../../../pages/api/accounting/audit-comparisons')).default;
 server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1'),query:Record<string,string|string[]>={};
  for(const key of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(key);query[key]=values.length===1?values[0]!:values;}
  void apiResolver(req,res,query,{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
   .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic comparison REST failure');});});
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic comparison REST listener missing');const port=address.port;
 async function request(method:'GET'|'POST',input:Record<string,unknown>|URLSearchParams,person:'u1'|'u3'='u1',validCsrf=true){
  const user=f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
  const query=input instanceof URLSearchParams?input:new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)]));
  const response=await fetch(`http://127.0.0.1:${port}/api/accounting/audit-comparisons${method==='GET'?`?${query}`:''}`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},...(method==='POST'?{body:JSON.stringify(input)}:{})});
  return{status:response.status,body:await response.json()};
 }
 return{f,pool,records,first:snapshots[0]!,second:snapshots[1]!,request,run:(jobId:string)=>runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId},{pool,workerClass:'audit'}),close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic comparison setup failed');}throw error;}
}
