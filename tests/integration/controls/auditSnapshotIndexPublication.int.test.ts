import {getAuditSnapshotPage,readAuditSnapshotChunk} from '@/modules/accounting/services/controls/auditSnapshotPageService';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(person:'u1'|'u2'|'u3',action:()=>Promise<T>){
 const user=fixture[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
  store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},action));
}
async function publish(){
 const job=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
 expect(await runAuditSnapshotJob({companyId:fixture.companyA,personId:fixture.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});return job.id;
}
it('publishes the authenticated bounded index in the actual worker success transaction',async()=>{
 const id=await publish();
 expect((await pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[fixture.companyA,id])).rows).toHaveLength(1);
});

it('pages real retained records and reads original chunks after source edits without full-blob loading',async()=>{
 const ids=Array.from({length:105},()=>randomUUID());
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by) SELECT id,$2,'2026-09-09',left(id::text,20),'manual','draft',$3 FROM unnest($1::uuid[]) id",[ids,fixture.companyA,fixture.u1.id]);
 const id=await publish();
 await pool.query("UPDATE gl_journal_entries SET entry_date='2026-09-10' WHERE company_id=$1 AND id=ANY($2::uuid[])",[fixture.companyA,ids]);
 const saved=(await pool.query('SELECT protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].protected_snapshot;
 // The index is independently authenticated; foreground reads do not decrypt the original whole-blob representation.
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=$2",[fixture.companyA,id]);
 try{
  let cursor:string|undefined;const ordinals:number[]=[];
  do{
   const page=await actor('u1',()=>getAuditSnapshotPage(requireControlTx(),{snapshotId:id,section:'records',limit:40,...cursor?{cursor}:{}}));
   expect(page.total).toBe(105);ordinals.push(...page.items.map(item=>item.ordinal));cursor=page.nextCursor??undefined;
  }while(cursor);
  expect(ordinals).toEqual(Array.from({length:105},(_,i)=>i));
  const chunk=await actor('u1',()=>readAuditSnapshotChunk(requireControlTx(),{snapshotId:id,section:'records',ordinal:0,chunkOrdinal:0}));
  const record=JSON.parse(Buffer.from(chunk.bytes).toString());expect(ids).toContain(record.id);expect(record.data.entry_date).toBe('2026-09-09');
 }finally{await pool.query('UPDATE control_audit_snapshots SET protected_snapshot=$3::jsonb WHERE company_id=$1 AND id=$2',[fixture.companyA,id,JSON.stringify(saved)]);}
});
it('refuses another tenant and rechecks revoked payroll authority even for journal pages',async()=>{
 const id=await publish();
 await expect(actor('u3',()=>getAuditSnapshotPage(requireControlTx(),{snapshotId:id,section:'records'}))).rejects.toThrow(/unavailable/);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor('u1',()=>getAuditSnapshotPage(requireControlTx(),{snapshotId:id,section:'records'}))).rejects.toThrow();}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('rolls back snapshot and all index rows if a chunk write fails before success',async()=>{
 const journal=randomUUID();await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by) VALUES($1,$2,'2026-09-09',left($1::uuid::text,20),'manual','draft',$3)",[journal,fixture.companyA,fixture.u1.id]);
 const job=await actor('u1',()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await pool.query("CREATE FUNCTION forensic_test_reject_index_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic index write failure'; END $$");
 await pool.query('CREATE TRIGGER forensic_test_reject_index_chunk BEFORE INSERT ON control_audit_snapshot_index_chunks FOR EACH ROW EXECUTE FUNCTION forensic_test_reject_index_chunk()');
 try{
  expect(await runAuditSnapshotJob({companyId:fixture.companyA,personId:fixture.u1.id,jobId:job.id},{pool})).toMatchObject({state:'failed',failureRecorded:true});
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
  expect((await pool.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 }finally{await pool.query('DROP TRIGGER forensic_test_reject_index_chunk ON control_audit_snapshot_index_chunks');await pool.query('DROP FUNCTION forensic_test_reject_index_chunk()');}
});
