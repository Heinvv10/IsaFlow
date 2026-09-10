import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {COMPARISON_SECTIONS,type ComparisonChange} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import type {ComparisonResultHeader} from '@/modules/accounting/services/controls/auditComparisonResultProtection';
type Job={id:string;state:string;attempts:number;resultComparisonId?:string};
type Page=Pick<ComparisonResultHeader,'version'|'companyId'|'permissions'|'canonicalHash'|'comparisonRuleVersion'|'first'|'second'|'counts'|'populationChanged'|'coverageChanged'> & {comparisonId:string;section:typeof COMPARISON_SECTIONS[number];total:number;items:ComparisonChange[];nextCursor:string|null};
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,first:string,second:string,comparison:string;
const retry=randomUUID();
beforeAll(async()=>{f=await auditDeliveryFixture();
 const make=async(sources:string[])=>{
  const job=await f.call<Job>('audit_snapshot',{cutoff:'2026-09-09',sources,checks:[],idempotency_key:randomUUID()});
  expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:job.id},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded'});return job.id;
 };
 first=await make(['journals','payroll']);
 // Synthetic change after retaining the original; complete approved correction workflow is tested separately.
 await f.pool.query("UPDATE gl_journal_entries SET description='Changed after original retention' WHERE company_id=$1 AND id=$2",[f.fixture.companyA,f.journal]);
 second=await make(['journals','bank']);
},30000);
afterAll(async()=>{if(f)await f.close();});
it('actual default MCP HTTP enqueues once, publishes ordered changes and delivers the complete verifiable result',async()=>{
 const args={first_snapshot_id:first,second_snapshot_id:second,idempotency_key:retry,company_id:f.fixture.companyA};
 const [a,b]=await Promise.all([f.call<Job>('compare_audit_snapshots',args),f.call<Job>('compare_audit_snapshots',args)]);
 expect(a.id).toBe(b.id);comparison=a.id;
 expect(await f.call<Job>('audit_job_status',{job_id:comparison})).toMatchObject({state:'queued',attempts:0});
 expect((await f.rpc('audit_comparison_items',{comparison_id:comparison,section:'records'})).result?.isError).toBe(true);
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:comparison},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded',comparisonId:comparison});
 expect(await f.call<Job>('audit_job_status',{job_id:comparison})).toMatchObject({state:'succeeded',resultComparisonId:comparison});
 const digest=createHash('sha256').update('isaflow.audit-comparison-result.v1\n'),changes:ComparisonChange[]=[];let footer:Page|undefined;
 for(const section of COMPARISON_SECTIONS){let cursor:string|undefined,position=0;
  do{const page=await f.call<Page>('audit_comparison_items',{comparison_id:comparison,section,limit:1,...(cursor?{cursor}:{})},'u2');
   footer=page;expect(page.items.length).toBeLessThanOrEqual(1);for(const change of page.items){digest.update(canonicalJson({section,position:position++,change})+'\n');changes.push(change);}cursor=page.nextCursor??undefined;
  }while(cursor);
 }
 expect(footer).toBeDefined();expect(footer!.first.id).toBe(first);expect(footer!.second.id).toBe(second);
 const {version,companyId,comparisonRuleVersion,first:before,second:after,permissions,counts,populationChanged,coverageChanged}=footer!;
 expect(companyId).toBe(f.fixture.companyA);expect(version).toBe(1);expect(permissions).toEqual(['read:bank-tx','read:payroll','read:reports']);
 digest.update(canonicalJson({version,companyId,comparisonRuleVersion,first:before,second:after,permissions,counts,populationChanged,coverageChanged})+'\n');
 expect(digest.digest('hex')).toBe(footer!.canonicalHash);
 expect(changes).toContainEqual(expect.objectContaining({section:'records',kind:'changed',identity:{source:'journal_entry',id:f.journal}}));
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:comparison},{pool:f.pool,workerClass:'audit'})).toEqual({state:'not_claimed'});
},30000);
it('rechecks both source domains before successful MCP retry and retained result reads',async()=>{
 for(const module of ['payroll','banking']){
  await f.pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.fixture.companyA,f.fixture.u1.id,module]);
  try{
   expect((await f.rpc('compare_audit_snapshots',{first_snapshot_id:first,second_snapshot_id:second,idempotency_key:retry},'u1',true)).result?.isError).toBe(true);
   expect((await f.rpc('audit_comparison_items',{comparison_id:comparison,section:'records'})).result?.isError).toBe(true);
  }finally{await f.pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.fixture.companyA,f.fixture.u1.id,module]);}
 }
});
it('refuses foreign sources and retained results, caller authority and oversized pages',async()=>{
 expect((await f.rpc('compare_audit_snapshots',{first_snapshot_id:first,second_snapshot_id:second,idempotency_key:randomUUID()},'u3')).result?.isError).toBe(true);
 expect((await f.rpc('audit_comparison_items',{comparison_id:comparison,section:'records'},'u3')).result?.isError).toBe(true);
 for(const extra of [{permissions:['read:reports']},{firstCanonicalHash:'a'.repeat(64)}])
  expect((await f.rpc('compare_audit_snapshots',{first_snapshot_id:first,second_snapshot_id:second,idempotency_key:randomUUID(),...extra})).result?.isError).toBe(true);
 expect((await f.rpc('audit_comparison_items',{comparison_id:comparison,section:'records',limit:101})).result?.isError).toBe(true);
});
it('queues genuine indexless originals through MCP without foreground conversion and preserves replay after background publication',async()=>{
 const ids:string[]=[];
 for(const sources of [['journals','payroll'],['journals','bank']]){
  const job=await f.call<Job>('audit_snapshot',{cutoff:'2026-09-09',sources,checks:[],idempotency_key:randomUUID()});ids.push(job.id);
  expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:job.id},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded'});
 }
 const originals=(await f.pool.query('SELECT id,canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.fixture.companyA,ids])).rows;
 for(const table of ['control_audit_snapshot_index_chunks','control_audit_snapshot_index_items','control_audit_snapshot_indexes','control_audit_comparison_source_items','control_audit_comparison_sources'])
  await f.pool.query(`DELETE FROM ${table} WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])`,[f.fixture.companyA,ids]);
 const args={first_snapshot_id:ids[0],second_snapshot_id:ids[1],idempotency_key:randomUUID()};
 const job=await f.call<Job>('compare_audit_snapshots',args);
 expect(await f.call<Job>('audit_job_status',{job_id:job.id})).toMatchObject({state:'queued',attempts:0});
 expect((await f.pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])',[f.fixture.companyA,ids])).rows).toEqual([]);
 expect((await f.call<Job>('compare_audit_snapshots',args)).id).toBe(job.id);
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:job.id},{pool:f.pool,workerClass:'audit'})).toMatchObject({state:'succeeded',comparisonId:job.id});
 const page=await f.call<Page>('audit_comparison_items',{comparison_id:job.id,section:'records'});expect(page.first.id).toBe(ids[0]);expect(page.second.id).toBe(ids[1]);
 expect((await f.call<Job>('compare_audit_snapshots',args)).id).toBe(job.id);
 expect((await f.pool.query('SELECT id,canonical_hash,protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[f.fixture.companyA,ids])).rows).toEqual(originals);
 expect((await f.pool.query('SELECT build_job_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=ANY($2::uuid[])',[f.fixture.companyA,ids])).rows).toEqual([{build_job_id:job.id},{build_job_id:job.id}]);
},30000);
