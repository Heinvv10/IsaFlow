import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {als} from '@/lib/als';
import {log} from '@/lib/logger';
import {sql} from '@/lib/neon';
import {canonicalJson} from './canonical';
import {runAuditJob,type AuditWorkerResult} from './auditJobRunner';
const schema=z.object({companyIds:z.array(z.string().uuid()).min(1).max(10).refine(ids=>new Set(ids).size===ids.length),
 batchSize:z.number().int().min(1).max(10).default(10)}).strict();
export interface AuditPollerConfig{companyIds:string[];batchSize?:number}
interface Cursor{jobId:string;updatedAt:string}
interface Candidate extends Cursor{personId:string}
/** Bound acquisition without leaking a client that arrives after timeout/cancellation. */
async function connect(pool:Pool,signal?:AbortSignal):Promise<PoolClient>{
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  let finished=false;
  const finish=(error:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);};
  const abort=()=>finish(signal?.reason??new Error('Audit poll cancelled'));
  const timer=setTimeout(()=>finish(new Error('Audit queue connection deadline')),5000);
  signal?.addEventListener('abort',abort,{once:true});
  pool.connect().then(client=>{
   if(finished){client.release();return;}finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(client);
  },finish);
 });
}
async function candidates(pool:Pool,companyId:string,limit:number,cursor:Cursor|undefined,signal?:AbortSignal):Promise<Candidate[]>{
 const client=await connect(pool,signal);let broken=false;
 try{
  signal?.throwIfAborted();await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='5000ms'");
  const rows=await als.run({client,userId:'audit-queue-poller',companyId,claims:{}},async()=>await sql`
   SELECT j.job_id AS "jobId",i.requester_person_id AS "personId",j.updated_at::text AS "updatedAt"
   FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
   WHERE j.company_id=${companyId}::uuid AND (j.state='queued' OR (j.state='running' AND j.lease_expires_at<=clock_timestamp()))
    AND (${cursor?.updatedAt??null}::timestamptz IS NULL OR (j.updated_at,j.job_id)>(${cursor?.updatedAt??null}::timestamptz,${cursor?.jobId??null}::uuid))
   ORDER BY j.updated_at,j.job_id LIMIT ${limit}`) as Candidate[];
  signal?.throwIfAborted();await client.query('COMMIT');return rows;
 }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
 finally{client.release(broken);}
}
/** Server queue discovery is not business authority. Only the cold runner authenticates saved delegation. */
export function createAuditJobPoller(input:AuditPollerConfig,options:{pool:Pool}){
 const config=schema.parse(JSON.parse(canonicalJson(input))),cursors=new Map<string,Cursor>();
 let nextCompany=0,polling=false;
 return{async pollOnce(signal?:AbortSignal){
  if(als.getStore())throw new Error('Audit poller requires a cold boundary outside HTTP');
  if(polling)throw new Error('Audit queue poll already running');
  signal?.throwIfAborted();polling=true;
  const companyId=config.companyIds[nextCompany]!;nextCompany=(nextCompany+1)%config.companyIds.length;
  const results:AuditWorkerResult[]=[];
  try{
   const rows=await candidates(options.pool,companyId,config.batchSize,cursors.get(companyId),signal);
   if(!rows.length)cursors.delete(companyId);
   for(const row of rows){
    if(signal?.aborted)break;
    let result:AuditWorkerResult;
    try{result=await runAuditJob({companyId,personId:row.personId,jobId:row.jobId},{pool:options.pool,signal});}
    catch{
     log.warn('Audit queue candidate refused before claim',{companyId,jobId:row.jobId},'audit-worker');
     result={state:'failed',code:signal?.aborted?'CANCELLED':'WORKER_ERROR',failureRecorded:false};
    }
    results.push(result);
    if(result.state==='busy')break;
    cursors.set(companyId,{jobId:row.jobId,updatedAt:row.updatedAt});
   }
   return{companyId,attempted:results.length,results};
  }finally{polling=false;}
 }};
}
async function delay(ms:number,signal?:AbortSignal){
 if(signal?.aborted)return;
 await new Promise<void>(resolve=>{
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true});
 });
}
export async function runAuditJobPoller(input:AuditPollerConfig&{once?:boolean;intervalMs?:number},options:{pool:Pool;signal?:AbortSignal}){
 const saved=z.object({companyIds:schema.shape.companyIds,batchSize:schema.shape.batchSize,
  once:z.boolean().default(false),intervalMs:z.number().int().min(1000).max(60000).default(5000)}).strict().parse(JSON.parse(canonicalJson(input)));
 const poller=createAuditJobPoller({companyIds:saved.companyIds,batchSize:saved.batchSize},options);
 let polls=0,attempted=0;
 while(!options.signal?.aborted){
  try{const result=await poller.pollOnce(options.signal);polls++;attempted+=result.attempted;}
  catch(error){if(options.signal?.aborted)break;throw error;}
  if(saved.once)break;await delay(saved.intervalMs,options.signal);
 }
 return{polls,attempted};
}
