import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture,type FixtureUser} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
/**
 * The lockout and consent class the check-run review found, closed for snapshots, exports and comparisons: each
 * enqueue requires write:audit on every transport, and each is bounded by a rolling 24 h company cap with a
 * per-member share beneath it. Seeds are attributed to synthetic requesters unless a member is named, and removed
 * after each gate so the next one starts from the same count.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
// Literal on purpose: the unit test pins AUDIT_ENQUEUE_QUOTAS to these.
const KINDS={audit_snapshot:{label:'snapshot',perCompany:50,perPrincipal:20},audit_export:{label:'export',perCompany:50,perPrincipal:20},
 audit_compare:{label:'comparison',perCompany:100,perPrincipal:40}} as const;
type Kind=keyof typeof KINDS;
let f:ForensicFixture,first:string,second:string;
const actor=<T>(user:FixtureUser,work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+60000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},work));
function enqueue(kind:Kind,user:FixtureUser){
 const idempotencyKey=randomUUID();
 return actor(user,()=>kind==='audit_snapshot'?enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey})
  :kind==='audit_export'?enqueueAuditExport(requireControlTx(),{snapshotId:first,idempotencyKey})
  :enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey}));
}
beforeAll(async()=>{
 f=await provisionForensicFixture(config);const ids:string[]=[];
 for(let index=0;index<2;index++){
  const job=await enqueue('audit_snapshot',f.u1);ids.push(job.id);
  if((await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).state!=='succeeded')throw new Error('Synthetic source snapshot failed');
 }
 [first,second]=ids as [string,string];
},120000);
afterAll(()=>pool.end());
let others:string[]=[];
async function seed(kind:Kind,count:number,minutesAgo:number,person?:string):Promise<string[]>{
 // The requester FK is to users, not membership: five synthetic user rows carry the seeds round-robin, under every share.
 if(!others.length)others=(await pool.query(`INSERT INTO users(id,email,role,is_active) SELECT id,id||'@forensic.invalid','viewer',true
  FROM (SELECT gen_random_uuid()::text AS id FROM generate_series(1,5)) u RETURNING id`)).rows.map(row=>row.id as string);
 const ids=(await pool.query(`INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request,created_at)
  SELECT $1,gen_random_uuid(),COALESCE($2,($6::text[])[1+g%5]),$3,'seed-'||gen_random_uuid(),repeat('0',64),'{"seed":true}'::jsonb,clock_timestamp()-make_interval(mins=>$4::int)
  FROM generate_series(1,$5::int) g RETURNING id`,[f.companyA,person??null,kind,minutesAgo,count,others])).rows.map(row=>row.id as string);
 await pool.query("INSERT INTO control_audit_jobs(company_id,job_id,generation,state,last_error_code,completed_at) SELECT $1,unnest($2::uuid[]),1,'failed','CANCELLED',clock_timestamp()",[f.companyA,ids]);
 return ids;
}
async function unseed(ids:string[]){
 await pool.query('DELETE FROM control_audit_jobs WHERE company_id=$1 AND job_id=ANY($2::uuid[])',[f.companyA,ids]);
 await pool.query('DELETE FROM control_audit_job_intents WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.companyA,ids]);
}
/** How many of this kind the company enqueued inside the window, real jobs included. */
const inWindow=async(kind:Kind)=>(await pool.query("SELECT count(*)::int AS n FROM control_audit_job_intents WHERE company_id=$1 AND kind=$2 AND created_at>clock_timestamp()-interval '24 hours'",[f.companyA,kind])).rows[0].n as number;
for(const kind of Object.keys(KINDS) as Kind[]){
 const {label,perCompany,perPrincipal}=KINDS[kind],quota=new RegExp(`Audit ${label} quota exceeded`);
 it(`${kind}: requires write:audit, and a refusal writes nothing`,async()=>{
  const before=await inWindow(kind);
  await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'audit',true,false)",[f.companyA,f.u2.id]);
  try{await expect(enqueue(kind,f.u2),`a member without write:audit enqueued an ${kind}`).rejects.toMatchObject({name:'EffectivePermissionError'});}
  finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='audit'",[f.companyA,f.u2.id]);}
  expect(await inWindow(kind)).toBe(before);
 });
 it(`${kind}: admits exactly the company cap inside the window and refuses the next`,async()=>{
  const seeded=await seed(kind,perCompany-1-await inWindow(kind),24*60-5);
  try{
   expect((await enqueue(kind,f.u1)).state,`the last ${kind} inside the company cap was refused`).toBe('queued');
   await expect(enqueue(kind,f.u2),`an ${kind} past the company cap was admitted`).rejects.toThrow(quota);
  }finally{await unseed(seeded);}
 });
 it(`${kind}: a run just outside the window no longer counts`,async()=>{
  const seeded=await seed(kind,perCompany,24*60+5);
  try{expect((await enqueue(kind,f.u2)).state,`${kind}s outside the window still counted`).toBe('queued');}finally{await unseed(seeded);}
 });
 it(`${kind}: one member past their share cannot deny a colleague`,async()=>{
  // The share is per requester: u1 at their share is refused, u2 in the same company is admitted.
  const seeded=await seed(kind,perPrincipal,60,f.u1.id);
  try{
   await expect(enqueue(kind,f.u1),`a member past their ${kind} share was admitted`).rejects.toThrow(quota);
   expect((await enqueue(kind,f.u2)).state,`one member's share denied a colleague`).toBe('queued');
  }finally{await unseed(seeded);}
 });
}
