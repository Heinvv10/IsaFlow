import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {readComparisonSourceHeader,iterateComparisonSourceItems} from '@/modules/accounting/services/controls/auditComparisonSourceRead';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture;
beforeAll(async()=>{f=await provisionForensicFixture(config);
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[Array.from({length:520},()=>randomUUID()),f.companyA,f.u1.id]);
});afterAll(()=>pool.end());
function actor<T>(fn:()=>Promise<T>){return withAuditWorkerTransaction(pool,{companyId:f.companyA,personId:f.u1.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:f.companyA,personId:f.u1.id,authMethod:'cookie'},fn));}
async function queued(){return actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));}
it('publishes authenticated comparison projections atomically through the real snapshot worker',async()=>{
 const job=await queued(),result=await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});
 expect(result.state).toBe('succeeded');if(result.state!=='succeeded')throw new Error('Worker failed');
 const records=await actor(async()=>{const ctx=requireControlTx(),header=await readComparisonSourceHeader(ctx,job.id,result.canonicalHash),rows=[];
  for await(const row of iterateComparisonSourceItems(ctx,header,'records'))rows.push(row);return rows;});
 expect(records).toHaveLength(520);expect(new Set(records.map(row=>row.ordinal)).size).toBe(520);
 const source=(await pool.query('SELECT build_job_id,build_generation FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,job.id])).rows;
 expect(source).toEqual([{build_job_id:job.id,build_generation:1}]);
});
it('refuses suppressed comparison item retention and rolls back the complete snapshot publication',async()=>{
 const job=await queued();
 await pool.query(`CREATE FUNCTION public.synthetic_comparison_source_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.companyA}'::uuid AND NEW.snapshot_id='${job.id}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$`);
 try{await pool.query('CREATE TRIGGER synthetic_comparison_source_suppress BEFORE INSERT ON control_audit_comparison_source_items FOR EACH ROW EXECUTE FUNCTION public.synthetic_comparison_source_suppress()');
  const result=await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});expect(result.state).toBe('failed');
  for(const table of ['control_audit_snapshots','control_audit_snapshot_indexes','control_audit_comparison_sources']){
   const column=table==='control_audit_snapshots'?'id':'snapshot_id';
   expect((await pool.query(`SELECT * FROM ${table} WHERE company_id=$1 AND ${column}=$2`,[f.companyA,job.id])).rows).toEqual([]);
  }
  expect((await pool.query('SELECT state,result_snapshot_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[f.companyA,job.id])).rows).toEqual([{state:'failed',result_snapshot_id:null}]);
 }finally{await pool.query('DROP TRIGGER IF EXISTS synthetic_comparison_source_suppress ON control_audit_comparison_source_items');await pool.query('DROP FUNCTION public.synthetic_comparison_source_suppress()');}
});
