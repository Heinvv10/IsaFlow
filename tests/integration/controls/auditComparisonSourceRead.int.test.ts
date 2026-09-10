import {beforeAll,afterAll,expect,it} from 'vitest';
import {comparisonSourceReadFixture} from './comparisonSourceReadFixture';
import {readComparisonSourceHeader,iterateComparisonSourceItems} from '@/modules/accounting/services/controls/auditComparisonSourceRead';
let f:Awaited<ReturnType<typeof comparisonSourceReadFixture>>;
beforeAll(async()=>{f=await comparisonSourceReadFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const header=()=>f.actor(ctx=>readComparisonSourceHeader(ctx,f.id,f.hash));
it('reads all520 originals over bounded pages without loading original seal or binary artifacts',async()=>{
 const before=(await f.pool.query('SELECT protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.f.companyA,f.id])).rows[0].protected_snapshot;
 await f.pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=$2",[f.f.companyA,f.id]);
 try{const values=await f.actor(async ctx=>{const h=await readComparisonSourceHeader(ctx,f.id,f.hash),rows=[];for await(const row of iterateComparisonSourceItems(ctx,h,'records'))rows.push(row);return rows;});
  expect(values).toHaveLength(520);expect(new Set(values.map(row=>row.ordinal)).size).toBe(520);
 }finally{await f.pool.query('UPDATE control_audit_snapshots SET protected_snapshot=$3::jsonb WHERE company_id=$1 AND id=$2',[f.f.companyA,f.id,JSON.stringify(before)]);}
});
it('refuses foreign tenant, wrong expected hash and current payroll revocation',async()=>{
 await expect(f.actor(ctx=>readComparisonSourceHeader(ctx,f.id,f.hash),'u3')).rejects.toThrow(/unavailable/);
 await expect(f.actor(ctx=>readComparisonSourceHeader(ctx,f.id,'a'.repeat(64)))).rejects.toThrow(/hash/);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.f.companyA,f.f.u1.id]);
 try{await expect(header()).rejects.toThrow();}finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.f.companyA,f.f.u1.id]);}
});
it('refuses a corrupted authenticated projection header',async()=>{
 await f.pool.query('UPDATE control_audit_comparison_sources SET protected_header=$3::jsonb WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,f.id,JSON.stringify({...f.projection.protectedHeader,authentication:'0'.repeat(64)})]);
 try{await expect(header()).rejects.toThrow(/authentication/);}finally{await f.pool.query('UPDATE control_audit_comparison_sources SET protected_header=$3::jsonb WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,f.id,JSON.stringify(f.projection.protectedHeader)]);}
});
it('independent census refuses omitted source rows and swapped encrypted positions fail authentication binding',async()=>{
 const first=f.projection.items[0]!;
 await f.pool.query("UPDATE control_audit_comparison_source_items SET section='evidenceGaps' WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND position=0",[f.f.companyA,f.id]);
 try{await expect(header()).rejects.toThrow(/count/);}finally{await f.pool.query("UPDATE control_audit_comparison_source_items SET section='records' WHERE company_id=$1 AND snapshot_id=$2 AND section='evidenceGaps' AND position=0",[f.f.companyA,f.id]);}
 await f.pool.query("UPDATE control_audit_comparison_source_items SET protected_item=$3::jsonb WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND position=1",[f.f.companyA,f.id,JSON.stringify(first.protectedItem)]);
 try{await expect(f.actor(async ctx=>{const h=await readComparisonSourceHeader(ctx,f.id,f.hash);for await(const row of iterateComparisonSourceItems(ctx,h,'records'))void row;})).rejects.toThrow(/identity/);}
 finally{await f.pool.query("UPDATE control_audit_comparison_source_items SET protected_item=$3::jsonb WHERE company_id=$1 AND snapshot_id=$2 AND section='records' AND position=1",[f.f.companyA,f.id,JSON.stringify(f.projection.items[1]!.protectedItem)]);}
});
it('reports a real retained snapshot without a projection explicitly and does no conversion',async()=>{
 const {enqueueAuditSnapshot}=await import('@/modules/accounting/services/controls/auditJobService');
 const {runAuditSnapshotJob}=await import('@/modules/accounting/services/controls/auditJobRunner');
 const {randomUUID}=await import('node:crypto');
 const job=await f.actor(ctx=>enqueueAuditSnapshot(ctx,{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:f.f.companyA,personId:f.f.u1.id,jobId:job.id},{pool:f.pool})).toMatchObject({state:'succeeded'});
 const saved=(await f.pool.query('SELECT canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.f.companyA,job.id])).rows[0];
 await expect(f.actor(ctx=>readComparisonSourceHeader(ctx,job.id,saved.canonical_hash))).rejects.toThrow('Comparison source projection unavailable');
 expect((await f.pool.query('SELECT snapshot_id FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.f.companyA,job.id])).rows).toHaveLength(0);
});
