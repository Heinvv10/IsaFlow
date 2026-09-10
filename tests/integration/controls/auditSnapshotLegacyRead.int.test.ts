import {readRetainedAuditSnapshotSeal} from '@/modules/accounting/services/controls/auditRetainedSnapshotSeal';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {publishAuditSnapshot,readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let f:ForensicFixture;
beforeAll(async()=>{f=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u3'='u1',lease?:AuditJobLease){const user=f[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const store={client,userId:user.id,companyId:user.companyId,claims};
  const result=lease?await withControlJobRequest(store,lease,fn):await withControlRequest(store,{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
async function historicalMaterial(){
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','ar','ap','bank','payroll'],checks:[],idempotencyKey:randomUUID()}));
 const lease=(await actor(()=>claimAuditJob(requireControlTx(),job.id,AUDIT_WORKER_CLASS_KINDS.audit)))!;
 const bytes=Buffer.from('Synthetic original evidence retained before Sage population expansion');
 const sources=['journal_entry','journal_line','customer_invoice','customer_invoice_line','customer_payment','customer_payment_allocation',
  'supplier_invoice','supplier_invoice_line','supplier_payment','supplier_payment_allocation','bank_transaction','bank_statement_import','bank_statement_attestation_intent','payroll_run','payroll_run_line'];
 const data={version:1 as const,companyId:f.companyA,snapshotId:job.id,cutoff:'2026-09-09',capturedAt:'2026-09-09T10:00:00.000Z',
  records:[{source:'supplier_invoice',id:randomUUID(),version:null,data:{total_amount:'115.00',currency:'ZAR'}}],
  populations:sources.map(source=>({source,count:source==='supplier_invoice'?1:0,excludedCount:0,exclusions:[]})),checks:[],
  evidence:[{id:'legacy-source',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'text/plain'}],
  coverage:['synthetic_historical_snapshot'],missingSources:['retained_historical_versions_unavailable']};
 return{job,lease,bytes,data,sealed:sealAuditSnapshot(data)};
}
/** Persist the exact historical representation written by publisher65ccb8de2, not the stricter current producer. */
async function storedLegacy(){
 const value=await historicalMaterial(),client=await pool.connect();
 const protectedSnapshot=protectChangeValues('audit_snapshot',null,{companyId:f.companyA,snapshotId:value.job.id,jobId:value.job.id,sealed:value.sealed}).protectedPayload;
 const protectedArtifact=protectChangeValues('audit_snapshot_artifact',null,{companyId:f.companyA,snapshotId:value.job.id,artifactId:'legacy-source',bytes:value.bytes.toString('base64')}).protectedPayload;
 try{await client.query('BEGIN');
  await client.query('INSERT INTO control_audit_snapshots(company_id,id,job_id,requester_person_id,cutoff,canonical_hash,protected_snapshot) VALUES($1,$2,$2,$3,$4,$5,$6::jsonb)',
   [f.companyA,value.job.id,f.u1.id,value.data.cutoff,value.sealed.canonicalHash,JSON.stringify(protectedSnapshot)]);
  await client.query("INSERT INTO control_audit_snapshot_artifacts(company_id,snapshot_id,artifact_id,protected_artifact) VALUES($1,$2,'legacy-source',$3::jsonb)",[f.companyA,value.job.id,JSON.stringify(protectedArtifact)]);
  const updated=await client.query("UPDATE control_audit_jobs SET state='succeeded',result_snapshot_id=$2,lease_id=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE company_id=$1 AND job_id=$2 AND lease_id=$3 AND state='running'",[f.companyA,value.job.id,value.lease.leaseId]);
  expect(updated.rowCount).toBe(1);await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return value;
}
it('reads authenticated historical15-source material without retroactively requiring a Sage population',async()=>{
 const value=await storedLegacy();
 const before=(await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,value.job.id])).rows[0];
 const retained=await actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id));
 expect(retained.sealed).toEqual(value.sealed);expect(retained.snapshot.populations).toHaveLength(15);
 expect(retained.snapshot.populations.some(row=>row.source==='sage_supplier_invoice')).toBe(false);
 expect(Buffer.from(retained.artifacts[0]!.bytes)).toEqual(value.bytes);
 expect((await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[f.companyA,value.job.id])).rows[0]).toEqual(before);
});
it('requires the new Sage population for new publication even though historical reads remain compatible',async()=>{
 const value=await historicalMaterial();
 await expect(actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'legacy-source',bytes:value.bytes}]),'u1',value.lease)).rejects.toThrow(/population/i);
 expect(await actor(()=>getAuditJob(requireControlTx(),value.job.id))).toMatchObject({state:'running',resultSnapshotId:null});
});
it('keeps current source permissions, tenant checks and byte authentication on historical reads',async()=>{
 const value=await storedLegacy();
 await expect(actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id),'u3')).rejects.toThrow(/unavailable/);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id))).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.companyA,f.u1.id]);}
 await pool.query("UPDATE control_audit_snapshot_artifacts SET protected_artifact=jsonb_set(protected_artifact,'{ciphertext}',to_jsonb('changed'::text)) WHERE company_id=$1 AND snapshot_id=$2",[f.companyA,value.job.id]);
 await expect(actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id))).rejects.toThrow();
});

it('loads the authenticated legacy seal without reading corrupt binary artifacts, while full export still rejects them',async()=>{
 const value=await storedLegacy();
 await pool.query("UPDATE control_audit_snapshot_artifacts SET protected_artifact='{}' WHERE company_id=$1 AND snapshot_id=$2",[f.companyA,value.job.id]);
 const retained=await actor(()=>readRetainedAuditSnapshotSeal(requireControlTx(),value.job.id));
 expect(retained.sealed).toEqual(value.sealed);expect(retained.snapshot.populations).toHaveLength(15);
 await expect(actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id))).rejects.toThrow();
 await expect(actor(()=>readRetainedAuditSnapshotSeal(requireControlTx(),value.job.id),'u3')).rejects.toThrow(/unavailable/);
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.companyA,f.u1.id]);
 try{await expect(actor(()=>readRetainedAuditSnapshotSeal(requireControlTx(),value.job.id))).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.companyA,f.u1.id]);}
});
