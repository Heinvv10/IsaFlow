import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {runAuditSnapshotJob,runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {readAuditComparisonHeader} from '@/modules/accounting/services/controls/auditComparisonReadHeader';
import {getAuditComparisonPage} from '@/modules/accounting/services/controls/auditComparisonPageService';
import {createComparisonResultDigest} from '@/modules/accounting/services/controls/auditComparisonResultDigest';
import {COMPARISON_SECTIONS} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
let f:ForensicFixture,first:string,second:string,comparisonId:string;
function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const user=f[person];return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+15000,undefined,
 store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},fn));
}
beforeAll(async()=>{
 f=await provisionForensicFixture(config);const ids:string[]=[];
 for(let index=0;index<2;index++){
  if(index)await pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,source,status,created_by,description) SELECT $1,'2026-09-09','manual','draft',$2,'Paging '||n FROM generate_series(1,250) n",[f.companyA,f.u1.id]);
  const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll','bank'],checks:[],idempotencyKey:randomUUID()}));ids.push(job.id);
  expect(await runAuditSnapshotJob({companyId:f.companyA,personId:f.u1.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});
 }
 [first,second]=ids as [string,string];
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));comparisonId=job.id;
 expect(await runAuditJob({companyId:f.companyA,personId:f.u1.id,jobId:comparisonId},{pool})).toMatchObject({state:'succeeded',comparisonId});
 // Readers must not load the original full seals, which are deliberately unavailable in this synthetic fixture.
 await pool.query("UPDATE control_audit_snapshots SET protected_snapshot='{}' WHERE company_id=$1 AND id=ANY($2::uuid[])",[f.companyA,ids]);
});
afterAll(()=>pool.end());
it('reads a real worker population through three authenticated pages as a different authorized person and recomputes the full digest',async()=>{
 const header=await actor(()=>readAuditComparisonHeader(requireControlTx(),comparisonId),'u2'),digest=createComparisonResultDigest();
 expect(header.counts.records).toEqual({first:0,second:250,added:250,removed:0,changed:0,unchanged:0});
 const pageSizes:number[]=[];
 for(const section of COMPARISON_SECTIONS){let cursor:string|undefined;
  do{const page=await actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section,...(cursor?{cursor}:{})}),'u2');
   expect(page.canonicalHash).toBe(header.canonicalHash);expect(page.total).toBe(section==='records'?250:0);
   for(const item of page.items){expect(item).toMatchObject({section,kind:'added',before:null,after:{snapshotId:second}});digest.append(item);}
   if(section==='records')pageSizes.push(page.items.length);cursor=page.nextCursor??undefined;
  }while(cursor);
 }
 expect(pageSizes).toEqual([100,100,50]);expect(digest.finish(header)).toBe(header.canonicalHash);
 await expect(actor(()=>getAuditJob(requireControlTx(),comparisonId),'u2')).rejects.toThrow(/not found/);
});
it('refuses foreign readers and both current domain revocations even after a successful read',async()=>{
 await expect(actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section:'records'}),'u3')).rejects.toThrow(/unavailable/);
 for(const module of ['payroll','banking']){
  await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[f.companyA,f.u2.id,module]);
  try{await expect(actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section:'records'}),'u2')).rejects.toThrow();}
  finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[f.companyA,f.u2.id,module]);}
 }
 expect((await actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section:'records',limit:1}),'u2')).items).toHaveLength(1);
});
it('refuses tampered headers and swapped independently authenticated item positions',async()=>{
 const result=(await pool.query('SELECT protected_header FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.companyA,comparisonId])).rows[0];
 await pool.query("UPDATE control_audit_comparison_results SET protected_header='{}' WHERE company_id=$1 AND job_id=$2",[f.companyA,comparisonId]);
 try{await expect(actor(()=>readAuditComparisonHeader(requireControlTx(),comparisonId))).rejects.toThrow();}
 finally{await pool.query('UPDATE control_audit_comparison_results SET protected_header=$3 WHERE company_id=$1 AND job_id=$2',[f.companyA,comparisonId,result.protected_header]);}
 const rows=(await pool.query("SELECT position,protected_item FROM control_audit_comparison_items WHERE company_id=$1 AND job_id=$2 AND section='records' AND position<2 ORDER BY position",[f.companyA,comparisonId])).rows;
 await pool.query("UPDATE control_audit_comparison_items SET protected_item=$3 WHERE company_id=$1 AND job_id=$2 AND section='records' AND position=0",[f.companyA,comparisonId,rows[1].protected_item]);
 try{await expect(actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section:'records',limit:1}))).rejects.toThrow(/identity/);}
 finally{await pool.query("UPDATE control_audit_comparison_items SET protected_item=$3 WHERE company_id=$1 AND job_id=$2 AND section='records' AND position=0",[f.companyA,comparisonId,rows[0].protected_item]);}
});
it('independent census detects missing output outside the requested first page',async()=>{
 await pool.query("UPDATE control_audit_comparison_items SET section='evidence' WHERE company_id=$1 AND job_id=$2 AND section='records' AND position=249",[f.companyA,comparisonId]);
 try{await expect(actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId,section:'records',limit:1}))).rejects.toThrow(/population/);}
 finally{await pool.query("UPDATE control_audit_comparison_items SET section='records' WHERE company_id=$1 AND job_id=$2 AND section='evidence' AND position=249",[f.companyA,comparisonId]);}
});
it('queued results remain unavailable without claiming or executing their jobs',async()=>{
 const job=await actor(()=>enqueueAuditComparison(requireControlTx(),{firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:randomUUID()}));
 await expect(actor(()=>getAuditComparisonPage(requireControlTx(),{comparisonId:job.id,section:'records'}))).rejects.toThrow(/unavailable/);
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'queued',attempts:0,resultComparisonId:null});
});
