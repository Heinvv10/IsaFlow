import {publishAuditComparison} from './auditComparisonPublication';
import {z} from 'zod';
import type {Pool} from 'pg';
import {als} from '@/lib/als';
import {getAuthPool} from '@/lib/auth/authPool';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {log} from '@/lib/logger';
import {canonicalJson} from './canonical';
import {AUDIT_WORKER_CLASS_KINDS,isAuditWorkerClass,type AuditJobKind,type AuditWorkerClass} from './auditJobContract';
import {AUDIT_PROCESS_LIMITS,type AuditClassLimits} from './auditJobProcessContract';
import {claimAuditJobForWorker,failAuditJobForWorker,type AuditJobLease,type AuditJobErrorCode} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {withControlJobRequest,requireControlTx} from './context';
import {captureAuditSnapshot} from './auditSnapshotCapture';
import {retainSnapshotEvidence} from './auditSnapshotEvidence';
import {sealAuditSnapshot} from './auditSnapshotSeal';
import {publishAuditSnapshot} from './auditSnapshotPublication';
import {exportAuditEvidence} from './auditEvidenceExportService';
import {publishAuditExport} from './auditExportPublication';
import {CapturedEvidenceUnavailableError} from './capturedEvidenceSource';
import {CheckRunResourceLimitError} from './auditCheckRunBudget';
import {runAuditCheckRunPhase} from './auditCheckRunPhase';
import {publishAuditCheckRunUnknown} from './auditCheckRunUnknown';
import {withAuditWorkerTransaction,type AuditWorkerIdentity} from './auditWorkerTransaction';
const identitySchema=z.object({companyId:z.string().uuid(),personId:z.string().min(1).max(256),jobId:z.string().uuid()}).strict();
export type AuditWorkerResult={state:'busy'|'not_claimed'}|{state:'succeeded';snapshotId:string;canonicalHash:string}
 |{state:'succeeded';exportId:string;canonicalHash:string}
 |{state:'succeeded';comparisonId:string;canonicalHash:string}
 |{state:'succeeded';checkRunId:string;canonicalHash:string}
 |{state:'failed';code:AuditJobErrorCode;failureRecorded:boolean};
let running=false;
function failureCode(error:unknown,signal:AbortSignal|undefined,timedOut:boolean):AuditJobErrorCode{
 if(signal?.aborted)return 'CANCELLED';if(timedOut)return 'RESOURCE_LIMIT';
 if(error instanceof EffectivePermissionError)return 'AUTHORITY_REVOKED';
 if(error instanceof CapturedEvidenceUnavailableError)return 'EVIDENCE_CHANGED';
 if(error instanceof Error&&/delegation expired/.test(error.message))return 'AUTHORITY_REVOKED';
 if(error instanceof Error&&/resource|deadline/i.test(error.message))return 'RESOURCE_LIMIT';
 return 'WORKER_ERROR';
}
/** Server worker entry, never a tool/status handler. One memory-heavy capture per process. */
export async function runAuditSnapshotJob(input:AuditWorkerIdentity,options:{pool?:Pool;signal?:AbortSignal}={}):Promise<AuditWorkerResult>{
 return executeAuditJob(input,options,'audit',true);
}
/** Dispatch is derived from authenticated stored intent, never a caller-selected business operation. The class is server configuration. */
export async function runAuditJob(input:AuditWorkerIdentity,options:{pool?:Pool;signal?:AbortSignal;workerClass:AuditWorkerClass;startedAt?:number}):Promise<AuditWorkerResult>{
 if(!isAuditWorkerClass(options?.workerClass))throw new Error('Explicit audit worker class required');
 if(options.startedAt!==undefined&&(!Number.isSafeInteger(options.startedAt)||options.startedAt>Date.now()+1000))throw new Error('Invalid audit worker spawn timestamp');
 return executeAuditJob(input,options,options.workerClass,false);
}
async function executeAuditJob(input:AuditWorkerIdentity,options:{pool?:Pool;signal?:AbortSignal;startedAt?:number},workerClass:AuditWorkerClass,snapshotOnly:boolean):Promise<AuditWorkerResult>{
 if(als.getStore())throw new Error('Audit runner cannot execute inside an HTTP transaction');
 const identity=identitySchema.parse(JSON.parse(canonicalJson(input)));
 if(running)return{state:'busy'};
 const limits:AuditClassLimits=AUDIT_PROCESS_LIMITS[workerClass],kinds:readonly AuditJobKind[]=AUDIT_WORKER_CLASS_KINDS[workerClass];
 const session={idleInTransactionMs:limits.idleInTransactionMs};
 const pool=options.pool??getAuthPool(),controller=new AbortController();
 running=true;let timedOut=false,lease:AuditJobLease|null=null,checkRun=false;
 // The class timer and the work transaction share one deadline, anchored at the parent's spawn when it is known; the claim
 // keeps its own short bound from now (plan v6 A7), never beyond that deadline.
 const deadlineAt=(options.startedAt??Date.now())+limits.workDeadlineMs,claimDeadlineAt=Math.min(Date.now()+limits.claimDeadlineMs,deadlineAt);
 const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('Audit worker resource deadline'));},Math.max(0,deadlineAt-Date.now()));
 const signal=AbortSignal.any([controller.signal,...options.signal?[options.signal]:[]]);
 try{
  lease=await withAuditWorkerTransaction(pool,identity,'read committed',claimDeadlineAt,signal,store=>claimAuditJobForWorker(store,identity.jobId,kinds),session);
  if(!lease)return{state:'not_claimed'};
  const currentLease=lease;
  const result=await withAuditWorkerTransaction(pool,identity,'repeatable read',deadlineAt,signal,store=>withControlJobRequest(store,currentLease,async()=>{
   const ctx=requireControlTx(),saved=await loadStoredAuditJobDelegation(ctx.sql,identity.companyId,identity.personId,currentLease);
   signal.throwIfAborted();
   if(saved.kind==='audit_compare'){
    if(snapshotOnly)throw new Error('Snapshot runner requires snapshot job kind');
    return publishAuditComparison(ctx,currentLease,{signal,deadlineAt});
   }
   if(saved.kind==='audit_check_run'){
    if(snapshotOnly)throw new Error('Snapshot runner requires snapshot job kind');
    checkRun=true;return runAuditCheckRunPhase(ctx,currentLease,{signal,deadlineAt});
   }
   if(saved.kind==='audit_export'){
    if(snapshotOnly)throw new Error('Snapshot runner requires snapshot job kind');
    const bundle=await exportAuditEvidence(ctx,saved.request.snapshotId,{signal,deadlineAt});
    signal.throwIfAborted();return publishAuditExport(ctx,currentLease,bundle,{signal,deadlineAt});
   }
   const snapshot=await captureAuditSnapshot(ctx,{snapshotId:identity.jobId,request:saved.request});
   signal.throwIfAborted();const retained=await retainSnapshotEvidence(ctx,snapshot,saved.request,signal);
   signal.throwIfAborted();const sealed=sealAuditSnapshot(retained.snapshot);signal.throwIfAborted();
   return publishAuditSnapshot(ctx,currentLease,sealed,retained.artifacts,{signal,deadlineAt});
  }),session);
  return{state:'succeeded',...result};
 }catch(error){
  // Phase A rolled back; the same lease still owns the job, so the limit is published as `unknown` on a fresh
  // read-committed transaction with its own short budget (plan v6 A21). Any failure there falls through to the
  // ordinary failure record below.
  if(checkRun&&lease&&error instanceof CheckRunResourceLimitError&&!signal.aborted&&!timedOut){
   const currentLease=lease,reason=error.reason;
   try{
    const published=await withAuditWorkerTransaction(pool,identity,'read committed',Date.now()+limits.unknownPublicationMs,signal,
     store=>withControlJobRequest(store,currentLease,()=>publishAuditCheckRunUnknown(requireControlTx(),currentLease,reason)),session);
    return{state:'succeeded',...published};
   }catch{log.warn('Audit check run resource limit could not be published',{jobId:identity.jobId,reason},'audit-worker');}
  }
  const code=failureCode(error,options.signal,timedOut);let failureRecorded=false;
  if(lease){
   const currentLease=lease;
   const pgCode=error!==null&&typeof error==='object'&&'code'in error?error.code:null;
   const retryable=code==='WORKER_ERROR'&&['40001','40P01','55P03'].includes(String(pgCode));
   try{
    await withAuditWorkerTransaction(pool,identity,'read committed',Date.now()+limits.failureRecordMs,undefined,store=>failAuditJobForWorker(store,currentLease,code,retryable),session);
    failureRecorded=true;
   }catch{log.warn('Audit worker failure could not be recorded with its current lease',{jobId:identity.jobId,code},'audit-worker');}
  }
  return{state:'failed',code,failureRecorded};
 }finally{clearTimeout(timer);running=false;}
}
