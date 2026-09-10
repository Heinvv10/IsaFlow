import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
/** Real cookie auth over loopback against the actual Next handler; no service is called directly. */
export async function auditCheckRunRestFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([pool.end(),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic check-run REST cleanup failed');
 }
 try{
  const f=await provisionForensicFixture(config);
  // Two journals posted on a Saturday evening against a backdated accounting date: three signals each, so the
  // findings page is genuinely paged rather than empty.
  for(const _row of [0,1])await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,posted_by,posted_at)
   VALUES(gen_random_uuid(),$1,left(gen_random_uuid()::text,20),'2026-08-31','posted','auto_migration',$2,$2,'2026-09-05T20:00:00+02:00')`,[f.companyA,f.u1.id]);
  const handler=(await import('../../../pages/api/accounting/audit-check-runs')).default;
  server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1'),query:Record<string,string|string[]>={};
   for(const key of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(key);query[key]=values.length===1?values[0]!:values;}
   void apiResolver(req,res,query,{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
    .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic check-run REST failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic check-run REST listener missing');const port=address.port;
  async function request(method:'GET'|'POST'|'DELETE',input:Record<string,unknown>,person:'u1'|'u3'='u1',validCsrf=true){
   const user=f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const query=new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)]));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/audit-check-runs${method==='GET'?`?${query}`:''}`,{method,redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},
    ...(method==='GET'?{}:{body:JSON.stringify(input)})});
   return{status:response.status,body:await response.json() as {data?:Record<string,unknown>;error?:unknown}};
  }
  return{f,pool,request,run:(jobId:string)=>runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId},{pool,workerClass:'check_run'}),close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic check-run REST setup failed');}throw error;}
}
