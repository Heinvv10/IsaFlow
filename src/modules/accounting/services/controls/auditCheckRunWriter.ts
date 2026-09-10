import type {ControlTx} from './contracts';
import type {AuditJobLease} from './auditJobLease';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
export interface StagedCheckRunFinding {ordinal:number;key:string;envelope:SnapshotIndexEnvelope}
/** One statement per batch, bounded by rows and by the bytes PostgreSQL will accept in a single jsonb parameter. */
const MAX_ROWS=512,MAX_BYTES=2097150;
/**
 * Batched sealed-finding writer. Every insert returns its own identity, and the batch is rejected unless the rows the
 * server acknowledges are exactly the rows this run staged: no silent partial write, no row landing on another job,
 * generation or ordinal. The UNIQUE(company, job, generation, finding_key) constraint turns a repeated key into a
 * failed run rather than a quietly deduplicated one.
 */
export function writeAuditCheckRunFindings(ctx:ControlTx,lease:AuditJobLease,check:()=>void){
 let batch:StagedCheckRunFinding[]=[],bytes=0;
 async function flush():Promise<void>{
  if(!batch.length)return;
  check();
  const encoded=JSON.stringify(batch.map(row=>({ordinal:row.ordinal,finding_key:row.key,protected_item:row.envelope})));
  const rows=await ctx.sql`INSERT INTO control_audit_check_findings(company_id,job_id,generation,lease_id,ordinal,finding_key,protected_item)
   SELECT ${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,x.ordinal,x.finding_key,x.protected_item
   FROM jsonb_to_recordset(${encoded}::jsonb) AS x(ordinal integer,finding_key text,protected_item jsonb)
   RETURNING company_id,job_id,generation,ordinal,finding_key` as {company_id:string;job_id:string;generation:string|number;ordinal:number;finding_key:string}[];
  const expected=new Map(batch.map(row=>[row.ordinal,row.key]));
  if(rows.length!==batch.length)throw new Error('Check run finding retention failed');
  for(const row of rows){
   if(row.company_id!==lease.companyId||row.job_id!==lease.jobId||Number(row.generation)!==lease.generation
    ||expected.get(row.ordinal)!==row.finding_key||!expected.delete(row.ordinal))throw new Error('Check run finding retention failed');
  }
  if(expected.size)throw new Error('Check run finding retention failed');
  check();batch=[];bytes=0;
 }
 return{
  async append(row:StagedCheckRunFinding):Promise<void>{
   const size=Buffer.byteLength(JSON.stringify(row))+1;
   if(size>MAX_BYTES)throw new Error('Check run finding SQL row resource limit');
   if(batch.length>=MAX_ROWS||bytes+size>MAX_BYTES)await flush();
   batch.push(row);bytes+=size;
  },
  flush,
 };
}
