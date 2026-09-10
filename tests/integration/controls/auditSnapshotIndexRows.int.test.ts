import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let f:ForensicFixture;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
beforeAll(async()=>{f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[Array.from({length:520},()=>randomUUID()),f.companyA,f.u1.id]);
});afterAll(()=>pool.end());
async function queued(){return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f.u1.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:f.companyA,personId:f.u1.id,authMethod:'cookie'},()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()})));}
it.each(['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks'])('rolls back all publication when %s silently suppresses an INSERT',async table=>{
 const job=await queued();
 await pool.query(`CREATE FUNCTION public.synthetic_index_rows_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.snapshot_id='${job.id}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
 try{
  await pool.query(`CREATE TRIGGER synthetic_index_rows_suppress BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_index_rows_suppress()`);
  const result=await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});
  expect(result).toMatchObject({state:'failed',failureRecorded:true});
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,job.id])).rows).toEqual([]);
  for(const retained of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks']){
   expect((await pool.query(`SELECT snapshot_id FROM ${retained} WHERE company_id=$1 AND snapshot_id=$2`,[f.companyA,job.id])).rows).toEqual([]);
  }
 }finally{
  await pool.query(`DROP TRIGGER IF EXISTS synthetic_index_rows_suppress ON ${table}`);
  await pool.query('DROP FUNCTION public.synthetic_index_rows_suppress()');
 }
});
it('retains actual builder lineage and all 520 original records and chunks through the snapshot worker',async()=>{
 const job=await queued();
 expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});
 const header=(await pool.query('SELECT build_job_id,build_generation,build_lease_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,job.id])).rows;
 expect(header).toEqual([{build_job_id:job.id,build_generation:'1',build_lease_id:expect.any(String)}]);
 for(const table of ['control_audit_snapshot_index_items','control_audit_snapshot_index_chunks']){
  const rows=(await pool.query(`SELECT ordinal FROM ${table} WHERE company_id=$1 AND snapshot_id=$2 AND section='records' ORDER BY ordinal`,[f.companyA,job.id])).rows;
  expect(rows.map(row=>row.ordinal)).toEqual(Array.from({length:520},(_,i)=>i));
 }
});
