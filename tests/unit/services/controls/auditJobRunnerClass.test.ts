import {beforeEach,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {claimAuditJobForWorker,failAuditJobForWorker} from '@/modules/accounting/services/controls/auditJobLease';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
vi.mock('@/modules/accounting/services/controls/auditWorkerTransaction',()=>({withAuditWorkerTransaction:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditJobLease',()=>({claimAuditJobForWorker:vi.fn(),failAuditJobForWorker:vi.fn()}));
const identity={companyId:'11111111-1111-4111-8111-111111111111',personId:'synthetic',jobId:'22222222-2222-4222-8222-222222222222'};
const pool={} as Pool,lease={...identity,leaseId:'33333333-3333-4333-8333-333333333333',generation:1};
interface Call {deadlineAt:number;limits:unknown;isolation:string}
let calls:Call[]=[];
beforeEach(()=>{
 calls=[];vi.mocked(claimAuditJobForWorker).mockReset().mockResolvedValue(lease);vi.mocked(failAuditJobForWorker).mockReset().mockResolvedValue(undefined);
 vi.mocked(withAuditWorkerTransaction).mockReset().mockImplementation(async(_pool,_identity,isolation,deadlineAt,_signal,work,limits)=>{
  calls.push({deadlineAt,limits,isolation});
  if(calls.length===1)return work({client:{} as never,userId:identity.personId,companyId:identity.companyId,claims:{}});
  // The authority pin is its own short transaction between the claim and the work (a synthetic pin stands in).
  if(calls.length===2)return Object.freeze({jobId:identity.jobId});
  if(calls.length===3)throw new Error('Synthetic work failure');
  return work({client:{} as never,userId:identity.personId,companyId:identity.companyId,claims:{}});
 });
});
it('bounds the claim and the authority pin separately and gives only the work transaction the class deadline',async()=>{
 for(const [workerClass,workMs,idle] of [['check_run',300000,15000],['audit',60000,null]] as const){
  calls=[];const before=Date.now();
  expect(await runAuditJob(identity,{pool,workerClass})).toMatchObject({state:'failed',code:'WORKER_ERROR',failureRecorded:true});
  const after=Date.now(),[claim,pin,work,failure]=calls;
  expect(claim!.isolation).toBe('read committed');expect(claim!.deadlineAt).toBeGreaterThanOrEqual(before+5000);expect(claim!.deadlineAt).toBeLessThanOrEqual(after+5000);
  expect(pin!.isolation).toBe('read committed');expect(pin!.deadlineAt).toBeGreaterThanOrEqual(before+5000);expect(pin!.deadlineAt).toBeLessThanOrEqual(after+5000);
  expect(work!.isolation).toBe('repeatable read');expect(work!.deadlineAt).toBeGreaterThanOrEqual(before+workMs);expect(work!.deadlineAt).toBeLessThanOrEqual(after+workMs);
  expect(failure!.deadlineAt-Date.now()).toBeLessThanOrEqual(5000);
  for(const call of calls)expect(call.limits).toEqual({idleInTransactionMs:idle});
 }
});
it('claims only the kinds of the configured class',async()=>{
 await runAuditJob(identity,{pool,workerClass:'check_run'});
 expect(vi.mocked(claimAuditJobForWorker).mock.calls[0]![2]).toEqual(['audit_check_run']);
 await runAuditJob(identity,{pool,workerClass:'audit'});
 expect(vi.mocked(claimAuditJobForWorker).mock.calls[1]![2]).toEqual(['audit_snapshot','audit_export','audit_compare']);
});
it('fails closed before any transaction when the worker class is missing or unknown',async()=>{
 for(const options of [{pool},{pool,workerClass:'admin'},{pool,workerClass:''}])
  await expect(runAuditJob(identity,options as never)).rejects.toThrow(/worker class/i);
 expect(withAuditWorkerTransaction).not.toHaveBeenCalled();
});
it('anchors the work deadline at the parent spawn timestamp while the claim keeps its own bound from now',async()=>{
 const spawnedAt=Date.now()-20000;
 await runAuditJob(identity,{pool,workerClass:'check_run',startedAt:spawnedAt});
 const [claim,pin,work]=calls,now=Date.now();
 expect(work!.deadlineAt).toBe(spawnedAt+300000);
 expect(claim!.deadlineAt).toBeGreaterThan(now+4000);expect(claim!.deadlineAt).toBeLessThanOrEqual(now+5000);
 expect(pin!.deadlineAt).toBeGreaterThan(now+4000);expect(pin!.deadlineAt).toBeLessThanOrEqual(now+5000);
 calls=[];const late=Date.now()-299000;
 await runAuditJob(identity,{pool,workerClass:'check_run',startedAt:late});
 expect(calls[0]!.deadlineAt).toBeLessThanOrEqual(late+300000);expect(calls[1]!.deadlineAt).toBeLessThanOrEqual(late+300000);
});
it('refuses a spawn timestamp that is not an integer in the past',async()=>{
 for(const startedAt of [Date.now()+60000,1.5,Number.NaN])
  await expect(runAuditJob(identity,{pool,workerClass:'check_run',startedAt})).rejects.toThrow(/spawn timestamp/i);
 expect(withAuditWorkerTransaction).not.toHaveBeenCalled();
});
it('requeues a job whose pin or work transaction lost a deadlock or a lock timeout instead of failing it',async()=>{
 for(const [code,at] of [['40P01',2],['55P03',2],['40P01',3],['55P03',3]] as const){
  calls=[];vi.mocked(failAuditJobForWorker).mockClear();
  vi.mocked(withAuditWorkerTransaction).mockImplementation(async(_pool,_identity,isolation,deadlineAt,_signal,work,limits)=>{
   calls.push({deadlineAt,limits,isolation});
   if(calls.length===at)throw Object.assign(new Error('Synthetic lock failure'),{code});
   if(calls.length===2)return Object.freeze({jobId:identity.jobId});
   return work({client:{} as never,userId:identity.personId,companyId:identity.companyId,claims:{}});
  });
  expect(await runAuditJob(identity,{pool,workerClass:'audit'})).toMatchObject({state:'failed',code:'WORKER_ERROR',failureRecorded:true});
  expect(vi.mocked(failAuditJobForWorker).mock.calls[0]![2]).toBe('WORKER_ERROR');
  expect(vi.mocked(failAuditJobForWorker).mock.calls[0]![3]).toBe(true);
 }
});
