import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {claimAuditJob,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {publishAuditSnapshot,readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u3'='u1',rollback=false,lease?:AuditJobLease){
 const user=fixture[person],client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,company_id:user.companyId,role:'authenticated'}),user.companyId]);
  const store={client,userId:user.id,companyId:user.companyId,claims:{}};
  const value=lease?await withControlJobRequest(store,lease,fn):await withControlRequest(store,{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  await client.query(rollback?'ROLLBACK':'COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function prepared(){
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const lease=(await actor(()=>claimAuditJob(requireControlTx(),job.id)))!;
 const bytes=Buffer.from('synthetic retained source bytes'),id=randomUUID();
 const data={version:1 as const,companyId:fixture.companyA,snapshotId:job.id,cutoff:'2026-09-09',capturedAt:new Date().toISOString(),
  records:[{source:'journal_entry',id,version:1,data:{amount:'123.00'}}],
  populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]},{source:'journal_line',count:0,excludedCount:0,exclusions:[]}],
  checks:[],evidence:[{id:'source',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'text/plain'}],coverage:[],missingSources:[]};
 return{job,lease,bytes,data,sealed:sealAuditSnapshot(data)};
}
it('publishes retained encrypted material and exact artifacts atomically with successful job status',async()=>{
 const value=await prepared();
 await actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'source',bytes:value.bytes}]),'u1',false,value.lease);
 expect(await actor(()=>getAuditJob(requireControlTx(),value.job.id))).toMatchObject({state:'succeeded',resultSnapshotId:value.job.id});
 const retained=await actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id));
 expect(retained.snapshot.records[0]!.data.amount).toBe('123.00');expect(Buffer.from(retained.artifacts[0]!.bytes)).toEqual(value.bytes);
 const stored=(await pool.query('SELECT protected_snapshot FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,value.job.id])).rows[0];
 expect(JSON.stringify(stored)).not.toContain('123.00');
 await expect(actor(()=>readRetainedAuditSnapshot(requireControlTx(),value.job.id),'u3')).rejects.toThrow(/unavailable/);
});
it('refuses altered or missing artifacts without publishing success',async()=>{
 const value=await prepared();
 await expect(actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[]),'u1',false,value.lease)).rejects.toThrow(/artifact/i);
 await expect(actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'source',bytes:Buffer.from('changed')}]),'u1',false,value.lease)).rejects.toThrow(/artifact/i);
 expect(await actor(()=>getAuditJob(requireControlTx(),value.job.id))).toMatchObject({state:'running',resultSnapshotId:null});
});
it('rolls back the whole publication and permits a later exact retry',async()=>{
 const value=await prepared();
 await actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'source',bytes:value.bytes}]),'u1',true,value.lease);
 expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,value.job.id])).rows).toHaveLength(0);
 expect(await actor(()=>getAuditJob(requireControlTx(),value.job.id))).toMatchObject({state:'running'});
 await actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'source',bytes:value.bytes}]),'u1',false,value.lease);
 expect(await actor(()=>getAuditJob(requireControlTx(),value.job.id))).toMatchObject({state:'succeeded'});
});
it('refuses a signed capture that omits a requested source population',async()=>{
 const value=await prepared(),sealed=sealAuditSnapshot({...value.data,populations:[value.data.populations[0]]});
 await expect(actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,sealed,[{id:'source',bytes:value.bytes}]),'u1',false,value.lease)).rejects.toThrow(/population/i);
});
it('refuses publication through a fresh cookie that could mask the original delegated grant',async()=>{
 const value=await prepared();
 await expect(actor(()=>publishAuditSnapshot(requireControlTx(),value.lease,value.sealed,[{id:'source',bytes:value.bytes}]))).rejects.toThrow(/delegated job context/);
});
