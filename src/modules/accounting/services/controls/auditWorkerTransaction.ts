import type {Pool} from 'pg';
import {als,type RequestContext} from '@/lib/als';
import {log} from '@/lib/logger';
import {acquireAuditWorkerConnection,cancelAuditWorkerBackend} from './auditWorkerConnection';
export interface AuditWorkerIdentity {companyId:string;personId:string;jobId:string}
/** Per-class session bounds; null keeps the server default (legacy audit class). */
export interface AuditWorkerTransactionLimits {idleInTransactionMs:number|null}
/** Cold transaction boundary. Cancellation completes before its backend can return to the pool. */
export async function withAuditWorkerTransaction<T>(pool:Pool,identity:AuditWorkerIdentity,isolation:'read committed'|'repeatable read',
 deadlineAt:number,signal:AbortSignal|undefined,work:(store:RequestContext)=>Promise<T>,limits:AuditWorkerTransactionLimits={idleInTransactionMs:null}):Promise<T>{
 if(als.getStore())throw new Error('Audit worker requires a cold transaction');
 signal?.throwIfAborted();
 const client=await acquireAuditWorkerConnection(pool,deadlineAt,signal);let cancellation:Promise<void>|undefined,backend:number|undefined,destroyed=false;
 const cancel=()=>{
  if(backend===undefined||cancellation)return;
  const pid=backend;
  cancellation=cancelAuditWorkerBackend(pool,pid).catch(()=>{
   log.warn('Audit worker cancellation request failed; closing its work connection',{},'audit-worker');
   destroyed=true;client.release(true);
  });
 };
 try{
  signal?.throwIfAborted();
  if(Date.now()>=deadlineAt)throw new Error('Audit worker resource deadline');
  await client.query(isolation==='repeatable read'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:identity.personId,company_id:identity.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true),set_config('statement_timeout',$3,true),set_config('lock_timeout',$4,true)",
   [JSON.stringify(claims),identity.companyId,`${Math.max(1,deadlineAt-Date.now())}ms`,'5000ms']);
  if(limits.idleInTransactionMs!==null){
   if(!Number.isSafeInteger(limits.idleInTransactionMs)||limits.idleInTransactionMs<1)throw new Error('Invalid audit worker idle bound');
   await client.query("SELECT set_config('idle_in_transaction_session_timeout',$1,true)",[`${limits.idleInTransactionMs}ms`]);
  }
  const result=await client.query('SELECT pg_backend_pid() AS pid');backend=Number(result.rows[0]?.pid);
  if(!Number.isInteger(backend)||backend<=0)throw new Error('Audit worker backend unavailable');
  signal?.addEventListener('abort',cancel,{once:true});signal?.throwIfAborted();
  const store:RequestContext={client,userId:identity.personId,companyId:identity.companyId,claims};
  const value=await work(store);
  signal?.throwIfAborted();if(Date.now()>=deadlineAt)throw new Error('Audit worker resource deadline');
  if(store.controlWriteFailed||store.criticalAuditFailed||store.txUnusable)throw new Error('Audit worker audit integrity failure');
  await client.query('COMMIT');return value;
 }catch(error){
  await cancellation;
  if(!destroyed){try{await client.query('ROLLBACK');}catch{log.warn('Audit worker rollback failed',{},'audit-worker');}}
  throw error;
 }finally{
  signal?.removeEventListener('abort',cancel);
  await cancellation;backend=undefined;if(!destroyed)client.release();
 }
}
