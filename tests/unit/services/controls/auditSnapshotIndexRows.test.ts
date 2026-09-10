import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import type {SnapshotIndexMaterial} from '@/modules/accounting/services/controls/auditSnapshotIndexContract';
const auth=vi.hoisted(()=>({lease:vi.fn(),permission:vi.fn(),saved:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditJobLease',()=>({assertAuditJobLease:auth.lease}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:auth.permission}));
vi.mock('@/modules/accounting/services/controls/auditJobDelegation',()=>({loadStoredAuditJobDelegation:auth.saved}));
const lease={companyId:'company',personId:'person',jobId:'builder',leaseId:'lease',generation:2} as AuditJobLease;
const envelope={ciphertext:'a',iv:'b',tag:'c',authentication:'d',version:1};
function material(count=1):SnapshotIndexMaterial{return {header:{version:1,companyId:'company',snapshotId:'builder',canonicalHash:'a'.repeat(64),permissions:['read:reports'],counts:{records:count,checks:0,findings:0,evidence:0,gaps:0}},protectedHeader:envelope,items:Array.from({length:count},(_,ordinal)=>({section:'records',ordinal,protectedItem:envelope,chunks:[envelope]}))} as SnapshotIndexMaterial;}
function context(suppress?:'header'|'item'|'chunk',wrong=false){
 const batches:number[]=[];
 const sql=vi.fn(async(strings:TemplateStringsArray,...values:unknown[])=>{
  const query=strings.join('?');
  if(query.includes('INSERT INTO control_audit_snapshot_indexes'))return suppress==='header'?[]:[{company_id:'company',snapshot_id:'builder',build_job_id:'builder',build_generation:2,build_lease_id:'lease'}];
  const kind=query.includes('index_items')?'item':'chunk';
  const encoded=values.find(value=>typeof value==='string'&&value.startsWith('[')) as string;
  const rows=JSON.parse(encoded) as {section:string;ordinal:number;chunk_ordinal?:number}[];batches.push(rows.length);
  if(suppress===kind)return [];
  return rows.map(row=>({company_id:'company',snapshot_id:wrong?'foreign':'builder',section:row.section,ordinal:row.ordinal,...kind==='chunk'?{chunk_ordinal:row.chunk_ordinal}:{}}));
 });
 return {ctx:{sql,principal:{companyId:'company',personId:'person',authMethod:'job',jobId:'builder',jobLeaseId:'lease',jobGeneration:2}} as unknown as ControlTx,batches,sql};
}
beforeEach(()=>{vi.clearAllMocks();auth.saved.mockResolvedValue({kind:'audit_snapshot',permissions:['read:reports'],request:{}});});
async function writer(){const module=await import('@/modules/accounting/services/controls/auditSnapshotIndexRows');return module.retainSnapshotIndexMaterial;}
it.each(['header','item','chunk'] as const)('refuses suppressed %s retention',async kind=>{
 const {ctx}=context(kind);await expect((await writer())(ctx,lease,'builder',material())).rejects.toThrow(/retention|incomplete|identity/i);
});
it('refuses returned rows for another snapshot despite matching cardinality',async()=>{
 const {ctx}=context(undefined,true);await expect((await writer())(ctx,lease,'builder',material())).rejects.toThrow(/identity|retention/i);
});
it('retains every row in bounded batches and returns the original header',async()=>{
 const {ctx,batches}=context(),input=material(1025);expect(await (await writer())(ctx,lease,'builder',input)).toBe(input.header);
 expect(batches).toEqual([512,512,1,512,512,1]);
});
it('refuses a snapshot worker targeting another original before SQL',async()=>{
 const {ctx,sql}=context();await expect((await writer())(ctx,lease,'other',material())).rejects.toThrow();expect(sql).not.toHaveBeenCalled();
});
it('refuses an unrelated comparison source before SQL',async()=>{
 auth.saved.mockResolvedValue({kind:'audit_compare',permissions:['read:reports'],request:{firstSnapshotId:'first',secondSnapshotId:'second'}});
 const {ctx,sql}=context();await expect((await writer())(ctx,lease,'builder',material())).rejects.toThrow();expect(sql).not.toHaveBeenCalled();
});
