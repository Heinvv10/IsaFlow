import {afterAll,beforeAll,expect,it} from 'vitest';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {publishAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
import {exportAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {verifyAuditEvidenceBundle} from '@/modules/accounting/services/controls/auditEvidenceExportMaterial';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u3'='u1',lease?:AuditJobLease){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,company_id:user.companyId,role:'authenticated'}),user.companyId]);
  const store={client,userId:user.id,companyId:user.companyId,claims:{}};
  const value=lease?await withControlJobRequest(store,lease,fn):await withControlRequest(store,{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function published(){
 const id=randomUUID();
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,description) VALUES($1,$2,$3,'2026-09-09','posted','auto_migration',$4,'Original retained description')",[id,fixture.companyA,id,fixture.u1.id]);
 const original=(await pool.query('SELECT description FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0];
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
 const lease=(await actor(()=>claimAuditJob(requireControlTx(),job.id,AUDIT_WORKER_CLASS_KINDS.audit)))!;
 const bytes=Buffer.from('synthetic original attachment');
 const data={version:1 as const,companyId:fixture.companyA,snapshotId:job.id,cutoff:'2026-09-09',capturedAt:new Date().toISOString(),
  records:[{source:'journal_entry',id,version:1,data:{description:original.description}}],
  populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]},
   ...['journal_line','payroll_run','payroll_run_line'].map(source=>({source,count:0,excludedCount:0,exclusions:[]}))],
  checks:[],evidence:[{id:'source',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'text/plain'}],coverage:[],missingSources:['original independent approval']};
 const sealed=sealAuditSnapshot(data);
 await actor(()=>publishAuditSnapshot(requireControlTx(),lease,sealed,[{id:'source',bytes}]),'u1',lease);
 return{job,id,bytes,sealed};
}
it('exports encrypted retained material after the actual original source changes without mutating storage',async()=>{
 const value=await published();
 const before=(await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,value.job.id])).rows[0];
 await pool.query("UPDATE gl_journal_entries SET description='Later changed source' WHERE company_id=$1 AND id=$2",[fixture.companyA,value.id]);
 const bundle=await actor(()=>exportAuditEvidence(requireControlTx(),value.job.id));
 const manifest=verifyAuditEvidenceBundle(bundle,{companyId:fixture.companyA,snapshotId:value.job.id});
 expect(manifest.canonicalSnapshotHash).toBe(value.sealed.canonicalHash);expect(manifest.missingSources).toContain('original independent approval');
 const json=Buffer.from(bundle.files.find(file=>file.path==='snapshot.json')!.bytes).toString();
 expect(json).toContain('Original retained description');expect(json).not.toContain('Later changed source');
 expect(Buffer.from(bundle.files.find(file=>file.path==='evidence/000001.bin')!.bytes)).toEqual(value.bytes);
 expect(Buffer.from(bundle.files.find(file=>file.path==='evidence.pdf')!.bytes).subarray(0,5).toString()).toBe('%PDF-');
 const after=(await pool.query('SELECT protected_snapshot,canonical_hash FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,value.job.id])).rows[0];
 expect(after).toEqual(before);
});
it('requires current underlying payroll permission even for an already retained snapshot',async()=>{
 const value=await published();
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 try{await expect(actor(()=>exportAuditEvidence(requireControlTx(),value.job.id))).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});
it('refuses foreign tenant and rejects tampered retained bytes before export',async()=>{
 const value=await published();
 await expect(actor(()=>exportAuditEvidence(requireControlTx(),value.job.id),'u3')).rejects.toThrow(/unavailable/);
 await pool.query("UPDATE control_audit_snapshot_artifacts SET protected_artifact=jsonb_set(protected_artifact,'{ciphertext}',to_jsonb('altered'::text)) WHERE company_id=$1 AND snapshot_id=$2",[fixture.companyA,value.job.id]);
 await expect(actor(()=>exportAuditEvidence(requireControlTx(),value.job.id))).rejects.toThrow();
});
