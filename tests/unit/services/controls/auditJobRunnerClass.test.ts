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
  if(calls.length===2)throw new Error('Synthetic work failure');
  return work({client:{} as never,userId:identity.personId,companyId:identity.companyId,claims:{}});
 });
});
it('bounds the claim separately and gives only the work transaction the class deadline',async()=>{
 for(const [workerClass,workMs,idle] of [['check_run',300000,15000],['audit',60000,null]] as const){
  calls=[];const before=Date.now();
  expect(await runAuditJob(identity,{pool,workerClass})).toMatchObject({state:'failed',code:'WORKER_ERROR',failureRecorded:true});
  const after=Date.now(),[claim,work,failure]=calls;
  expect(claim!.isolation).toBe('read committed');expect(claim!.deadlineAt).toBeGreaterThanOrEqual(before+5000);expect(claim!.deadlineAt).toBeLessThanOrEqual(after+5000);
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
