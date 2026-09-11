import {createServer} from 'node:http';
import {randomBytes,randomInt} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {SignJWT} from 'jose';
import type {NextApiHandler} from 'next';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
type Person='u1'|'u2'|'u3';
export interface Timed {ms:number;status:number;retryAfter:string|null;body:unknown}
/**
 * Real cookie and bearer requests over loopback into the actual Next handlers, plus a gate that pauses an audit
 * job inside its work transaction: a BEFORE INSERT trigger on the snapshot publication waits on an advisory key
 * this fixture holds, so the job sits in its work transaction with whatever locks it has taken until release.
 */
export async function authorityLockFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:8});
 const f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
 await pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[f.companyA,f.u1.id]);
 const routes:Record<string,NextApiHandler>={
  '/api/mcp':(await import('../../../pages/api/mcp/index')).default,
  '/api/accounting/control-approvals':(await import('../../../pages/api/accounting/control-approvals')).default,
  '/api/accounting/audit-check-runs':(await import('../../../pages/api/accounting/audit-check-runs')).default,
  '/api/accounting/permissions':(await import('../../../pages/api/accounting/permissions')).default,
  '/api/accounting/supplier-invoices-bulk-action':(await import('../../../pages/api/accounting/supplier-invoices-bulk-action')).default,
  '/api/accounting/recurring-invoices-run':(await import('../../../pages/api/accounting/recurring-invoices-run')).default,
  '/api/accounting/run-depreciation':(await import('../../../pages/api/accounting/run-depreciation')).default,
  '/api/accounting/bank-transactions-bulk-commit':(await import('../../../pages/api/accounting/bank-transactions-bulk-commit')).default,
  '/api/accounting/batch-payments':(await import('../../../pages/api/accounting/batch-payments')).default,
  '/api/accounting/batch-payments-action':(await import('../../../pages/api/accounting/batch-payments-action')).default,
 };
 const server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1'),query:Record<string,string>={};
  for(const [key,value] of url.searchParams)query[key]=value;
  const handler=routes[url.pathname];if(!handler){res.statusCode=404;res.end();return;}
  void apiResolver(req,res,query,{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
   .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic authority-lock failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback unavailable');
 const base=`http://127.0.0.1:${address.port}`;
 async function timed(path:string,init:RequestInit):Promise<Timed>{
  const started=Date.now(),response=await fetch(`${base}${path}`,{redirect:'error',signal:AbortSignal.timeout(12000),...init});
  const text=await response.text();let body:unknown=text;try{body=JSON.parse(text);}catch{/* non-JSON bodies are kept as text */}
  return{ms:Date.now()-started,status:response.status,retryAfter:response.headers.get('retry-after'),body};
 }
 async function rest(method:'GET'|'POST',path:string,input:Record<string,unknown>,person:Person='u1'):Promise<Timed>{
  const user=f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
  const query=method==='GET'?`?${new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)]))}`:'';
  return timed(`${path}${query}`,{method,headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},
   ...(method==='GET'?{}:{body:JSON.stringify(input)})});
 }
 let rpcId=0;
 async function mcp(name:string,args:Record<string,unknown>,person:Person='u1'):Promise<Timed>{
  return timed('/api/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${f[person].tokens[0]!.raw}`},
   body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});
 }
 const gateKey=randomInt(1,2**31-1),gateFunction=`zz_authority_gate_${randomBytes(6).toString('hex')}`;
 let gate:PoolClient|null=null;
 /** Pauses the next snapshot publication in company A until release(); lock_timeout 0 so the worker's 5 s bound does not end the pause. */
 async function holdPublication(){
  await pool.query(`CREATE FUNCTION ${gateFunction}() RETURNS trigger LANGUAGE plpgsql SET lock_timeout=0 AS $$ BEGIN
   IF NEW.company_id::text=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${gateFunction} BEFORE INSERT ON control_audit_snapshots FOR EACH ROW EXECUTE FUNCTION ${gateFunction}('${f.companyA}','${gateKey}')`);
  gate=await pool.connect();await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock($1::bigint)',[gateKey]);
 }
 /** The worker backend waiting at the gate, once it is there. */
 async function pausedWorker(timeoutMs=20000):Promise<number>{
  for(const until=Date.now()+timeoutMs;Date.now()<until;await new Promise(r=>setTimeout(r,50))){
   const rows=(await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=0 AND objid=$1::bigint::oid AND objsubid=1",[gateKey])).rows as {pid:number}[];
   if(rows[0])return rows[0].pid;
  }
  throw new Error('The audit job never reached the publication gate');
 }
 async function release(){
  if(gate){const client=gate;gate=null;try{await client.query('ROLLBACK');}finally{client.release();}}
  await pool.query(`DROP TRIGGER IF EXISTS ${gateFunction} ON control_audit_snapshots`);
  await pool.query(`DROP FUNCTION IF EXISTS ${gateFunction}()`);
 }
 /** Advisory locks a backend holds on company A's authority key: 'ExclusiveLock' | 'ShareLock'. */
 async function authorityLocks(pid?:number){
  return (await pool.query(`SELECT pid,mode,granted FROM pg_locks l WHERE locktype='advisory' AND objsubid=1
   AND ((classid::bigint<<32)|objid::bigint)=(SELECT hashtextextended('control-authority:'||$1::text,0)) AND ($2::int IS NULL OR pid=$2) ORDER BY pid`,[f.companyA,pid??null])).rows as {pid:number;mode:string;granted:boolean}[];
 }
 async function close(){
  await release();
  await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
  await (await import('@/lib/mcp/invocationStore')).closeInvocationPool();
  await (await import('@/lib/auth/authPool')).getAuthPool().end();
  await (await import('@/lib/neon')).getPoolForTests().end();await pool.end();
 }
 return{f,pool,rest,mcp,holdPublication,pausedWorker,release,authorityLocks,close};
}
