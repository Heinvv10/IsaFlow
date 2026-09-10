import {withSavepoint} from '@/lib/neon';
import type {ControlTx} from './contracts';
import {assertAuditJobLease,type AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {readAuditComparisonInputs} from './auditComparisonInputs';
import {ensureComparisonSource} from './auditComparisonSourcePublication';
import {iterateComparisonSourceItems} from './auditComparisonSourceRead';
import type {ComparisonSourceHeader} from './auditComparisonSourceProtection';
import {compareSnapshotStreams,type ComparisonSource,type ComparisonOptions,type ComparisonSection} from './auditSnapshotComparisonMaterial';
import {sealComparisonResultHeader,sealComparisonResultItem,type ComparisonResultHeader} from './auditComparisonResultProtection';
import {createComparisonResultDigest} from './auditComparisonResultDigest';
import {indexBudget} from './auditSnapshotIndexValidation';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
/** One worker transaction owns source conversion, provisional output and the final lease-fenced success pointer. */
export async function publishAuditComparison(ctx:ControlTx,lease:AuditJobLease,options?:ComparisonOptions){
 assertAuditJobLease(ctx,lease);
 if(ctx.principal.authMethod!=='job'||ctx.principal.jobId!==lease.jobId||ctx.principal.jobLeaseId!==lease.leaseId
  ||ctx.principal.jobGeneration!==lease.generation)throw new Error('Comparison publication requires original delegated worker authority');
 const check=indexBudget(options);check();
 return withSavepoint('audit_comparison_publish',async()=>{
  const saved=await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);
  if(saved.kind!=='audit_compare')throw new Error('Comparison publication requires comparison job kind');
  await readAuditComparisonInputs(ctx,saved.request);check();
  const first=await ensureComparisonSource(ctx,lease,saved.request.firstSnapshotId,options);
  const second=await ensureComparisonSource(ctx,lease,saved.request.secondSnapshotId,options);check();
  const source=(header:ComparisonSourceHeader):ComparisonSource=>{
   const section=(name:ComparisonSection)=>({count:header.counts[name],items:iterateComparisonSourceItems(ctx,header,name,options)});
   return{companyId:header.companyId,id:header.snapshotId,canonicalHash:header.canonicalHash,
    cutoff:header.cutoff,capturedAt:header.capturedAt,populationsHash:header.populationsHash,coverageHash:header.coverageHash,
    sections:{records:section('records'),checks:section('checks'),evidence:section('evidence'),evidenceGaps:section('evidenceGaps')}};
  };
  const identity={companyId:lease.companyId,comparisonId:lease.jobId,generation:lease.generation,leaseId:lease.leaseId};
  const positions:Record<ComparisonSection,number>={records:0,checks:0,evidence:0,evidenceGaps:0},digest=createComparisonResultDigest();
  let batch:Array<{section:ComparisonSection;position:number;envelope:SnapshotIndexEnvelope}>=[],bytes=0;
  async function flush(){
   if(!batch.length)return;check();const encoded=JSON.stringify(batch);
   const rows=await ctx.sql`INSERT INTO control_audit_comparison_items(company_id,job_id,generation,lease_id,section,position,protected_item)
    SELECT ${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,x.section,x.position,x.envelope
    FROM jsonb_to_recordset(${encoded}::jsonb) AS x(section text,position integer,envelope jsonb)
    RETURNING company_id,job_id,section,position` as {company_id:string;job_id:string;section:string;position:number}[];
   const expected=new Set(batch.map(row=>`${row.section}:${row.position}`));
   if(rows.length!==batch.length||rows.some(row=>row.company_id!==lease.companyId||row.job_id!==lease.jobId||!expected.delete(`${row.section}:${row.position}`))||expected.size)throw new Error('Comparison result item retention failed');
   check();batch=[];bytes=0;
  }
  const summary=await compareSnapshotStreams(source(first),source(second),async change=>{
   check();const position=positions[change.section]++,envelope=sealComparisonResultItem(identity,position,change);
   const row={section:change.section,position,envelope},size=Buffer.byteLength(JSON.stringify(row))+1;
   if(size>2097150)throw new Error('Comparison result SQL row resource limit');
   if(batch.length>=256||bytes+size>2097150)await flush();
   digest.append(change);batch.push(row);bytes+=size;
  },options);
  await flush();check();
  const header:ComparisonResultHeader={version:1,comparisonRuleVersion:1,...identity,...summary,permissions:saved.request.permissions,canonicalHash:'0'.repeat(64)};
  header.canonicalHash=digest.finish(header);
  // Success requires the original request, current source authority and the current unexpired lease after streaming too.
  await loadStoredAuditJobDelegation(ctx.sql,lease.companyId,lease.personId,lease);await readAuditComparisonInputs(ctx,saved.request);check();
  const rows=await ctx.sql`INSERT INTO control_audit_comparison_results(company_id,job_id,generation,lease_id,protected_header)
   VALUES(${lease.companyId}::uuid,${lease.jobId}::uuid,${lease.generation},${lease.leaseId}::uuid,${JSON.stringify(sealComparisonResultHeader(header))}::jsonb)
   RETURNING company_id,job_id` as {company_id:string;job_id:string}[];
  if(rows.length!==1||rows[0]?.company_id!==lease.companyId||rows[0].job_id!==lease.jobId)throw new Error('Comparison result header retention failed');
  const updated=await ctx.sql`UPDATE control_audit_jobs SET state='succeeded',result_comparison_id=${lease.jobId}::uuid,
   lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE company_id=${lease.companyId}::uuid AND job_id=${lease.jobId}::uuid AND state='running'
    AND lease_id=${lease.leaseId}::uuid AND generation=${lease.generation} AND lease_expires_at>clock_timestamp() RETURNING job_id`;
  if(updated.length!==1)throw new Error('Comparison publication lease expired or was replaced');
  check();return{comparisonId:lease.jobId,canonicalHash:header.canonicalHash};
 });
}
