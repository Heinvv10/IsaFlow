import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import type {RpcReply} from './client';
/** Write tools declared under a read:* scope: read-only authority must never write. */
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>;
beforeAll(async()=>{f=await auditDeliveryFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const text=(reply:RpcReply)=>reply.result?.content?.map(item=>item.text).join('\n')??'';
async function count(query:string,params:unknown[]){return Number((await f.pool.query<{n:number}>(query,params)).rows[0]!.n);}
const jobs=()=>count('SELECT count(*)::int AS n FROM control_audit_jobs WHERE company_id=$1',[f.fixture.companyA]);
async function retained(){
 const job=await f.call<{id:string}>('audit_snapshot',{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:randomUUID()});
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:job.id},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded'});
 return job.id;
}
it('audit job enqueue tools refuse read-only and write-only authority and enqueue with read:reports plus write:audit',async()=>{
 const first=await retained(),second=await retained();
 const cases:Array<[string,Record<string,unknown>]>=[['audit_snapshot',{cutoff:'2026-09-09',sources:['journals'],checks:[]}],
  ['export_audit_evidence',{snapshot_id:first}],['compare_audit_snapshots',{first_snapshot_id:first,second_snapshot_id:second}]];
 const readOnly=await f.scopedToken(['read:reports']),writeOnly=await f.scopedToken(['write:audit']),granted=await f.scopedToken(['read:reports','write:audit']);
 const outcomes:string[]=[];
 for(const [name,args] of cases)for(const [label,token] of [['read-only',readOnly],['write-only',writeOnly],['granted',granted]] as const){
  const before=await jobs(),reply=await f.rpcToken(token,name,{...args,idempotency_key:randomUUID()});
  outcomes.push(`${name} ${label}: ${reply.result?.isError?'refused':'accepted'}, jobs +${await jobs()-before}`);
 }
 expect(outcomes).toEqual(cases.flatMap(([name])=>[`${name} read-only: refused, jobs +0`,`${name} write-only: refused, jobs +0`,`${name} granted: accepted, jobs +1`]));
},120000);
it('lock_vat_period dry run runs the same authority the live lock runs',async()=>{
 const period={period_start:'2031-03-01',period_end:'2031-04-30'};
 const locks=()=>count('SELECT count(*)::int AS n FROM vat_period_locks WHERE company_id=$1 AND period_start=$2 AND period_end=$3',[f.fixture.companyA,period.period_start,period.period_end]);
 const preview=await f.rpcToken(await f.scopedToken(['read:vat','write:post']),'lock_vat_period',{...period,dry_run:true,idempotency_key:randomUUID()});
 expect(preview.result?.isError,`preview without write:locks: ${text(preview)}`).toBe(true);
 const allowed=await f.rpcToken(await f.scopedToken(['read:vat','write:post','write:locks']),'lock_vat_period',{...period,dry_run:true,idempotency_key:randomUUID()});
 expect(allowed.result?.isError,text(allowed)).not.toBe(true);
 expect(JSON.parse(text(allowed))).toMatchObject({dryRun:true,wouldLock:true,alreadyLocked:null});
 expect(await locks()).toBe(0);
},60000);
it('lock_vat_period refuses read:vat without write:post and without write:locks, and locks with all three',async()=>{
 const period={period_start:'2031-01-01',period_end:'2031-02-28'};
 const locks=()=>count('SELECT count(*)::int AS n FROM vat_period_locks WHERE company_id=$1 AND period_start=$2 AND period_end=$3',[f.fixture.companyA,period.period_start,period.period_end]);
 const tokens=[['read:vat'],['read:vat','write:post'],['read:vat','write:locks']];
 for(const scopes of tokens){
  const reply=await f.rpcToken(await f.scopedToken(scopes),'lock_vat_period',{...period,idempotency_key:randomUUID()});
  expect(reply.result?.isError,`${scopes.join('+')}: ${text(reply)}`).toBe(true);
  expect(await locks(),scopes.join('+')).toBe(0);
 }
 const reply=await f.rpcToken(await f.scopedToken(['read:vat','write:post','write:locks']),'lock_vat_period',{...period,idempotency_key:randomUUID()});
 expect(reply.result?.isError,text(reply)).not.toBe(true);
 expect(JSON.parse(text(reply))).toMatchObject({created:true});
 expect(await locks()).toBe(1);
},60000);
