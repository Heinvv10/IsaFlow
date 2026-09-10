import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
import type {SnapshotIndexEnvelope} from '@/modules/accounting/services/controls/auditSnapshotIndexContract';
import type {ComparisonSection} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
export async function comparisonSourceReadFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const f=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
 async function actor<T>(action:(ctx:ControlTx)=>Promise<T>,who:'u1'|'u3'='u1'){
  const user=f[who];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
   store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>action(requireControlTx())));
 }
 try{
  const ids=Array.from({length:520},()=>randomUUID());
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,source,status,created_by) SELECT id,$2,'2026-09-09','manual','draft',$3 FROM unnest($1::uuid[]) id",[ids,f.companyA,f.u1.id]);
  const job=await actor(ctx=>enqueueAuditSnapshot(ctx,{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
  const outcome=await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool});
  if(outcome.state!=='succeeded')throw new Error('Synthetic retained snapshot worker failed');
  const retained=await actor(ctx=>readRetainedAuditSnapshot(ctx,job.id));
  // Read the real producer's envelopes for precise tamper/restore tests; this fixture publishes no companion rows.
  const source=(await pool.query('SELECT protected_header FROM control_audit_comparison_sources WHERE company_id=$1 AND snapshot_id=$2',[f.companyA,job.id])).rows[0];
  if(!source)throw new Error('Synthetic snapshot omitted comparison source');
  const items=(await pool.query('SELECT section,position,protected_item FROM control_audit_comparison_source_items WHERE company_id=$1 AND snapshot_id=$2 ORDER BY section,position',[f.companyA,job.id])).rows as {section:ComparisonSection;position:number;protected_item:SnapshotIndexEnvelope}[];
  const projection={protectedHeader:source.protected_header as SnapshotIndexEnvelope,items:items.map(row=>({section:row.section,position:row.position,protectedItem:row.protected_item}))};
  return{f,pool,actor,id:job.id,hash:retained.sealed.canonicalHash,projection,close:()=>pool.end()};
 }catch(error){await pool.end();throw error;}
}
