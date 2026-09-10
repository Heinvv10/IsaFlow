import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {ProtectedChange} from './changeProtection';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import {openAuditJobRequest} from './auditJobProtection';
import {readAuditComparisonInputs} from './auditComparisonInputs';
import {openComparisonResultHeader,type ComparisonResultHeader} from './auditComparisonResultProtection';
import {COMPARISON_SECTIONS,type ComparisonSection} from './auditSnapshotComparisonMaterial';
import {canonicalJson} from './canonical';
interface Row {id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange;
 generation:number|string;lease_id:string;protected_header:SnapshotIndexEnvelope}
/** Current readers retain access after the original execution delegation expires. No work is started here. */
export async function readAuditComparisonHeader(ctx:ControlTx,jobId:string):Promise<ComparisonResultHeader>{
 assertControlTx(ctx);jobId=z.string().uuid().parse(jobId).toLowerCase();await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT i.id,i.company_id,i.requester_person_id,i.kind,i.request_hash,i.protected_request,
  j.generation,r.lease_id,r.protected_header FROM control_audit_jobs j
  JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  JOIN control_audit_comparison_results r ON r.company_id=j.company_id AND r.job_id=j.job_id AND r.generation=j.generation
  WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.job_id=${jobId}::uuid
   AND j.state='succeeded' AND j.result_comparison_id=j.job_id` as Row[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Completed comparison unavailable');
 const saved=openAuditJobRequest(row);if(saved.kind!=='audit_compare')throw new Error('Comparison retained request kind changed');
 for(const permission of saved.request.permissions)await assertEffectivePermission(ctx,permission);
 const originals=await readAuditComparisonInputs(ctx,saved.request);
 const header=openComparisonResultHeader(row.protected_header,{companyId:ctx.principal.companyId,comparisonId:jobId,generation:Number(row.generation),leaseId:row.lease_id});
 if(header.comparisonRuleVersion!==saved.request.comparisonRuleVersion||canonicalJson(header.permissions)!==canonicalJson(saved.request.permissions))throw new Error('Comparison retained permissions or rule changed');
 for(const side of ['first','second'] as const){
  const original=originals[side],bound=header[side];
  if(bound.id!==original.snapshotId||bound.canonicalHash!==original.canonicalHash)throw new Error('Comparison retained source identity changed');
  const counts={records:original.counts.records,checks:original.counts.checks,evidence:original.counts.evidence,evidenceGaps:original.counts.gaps};
  for(const section of COMPARISON_SECTIONS)if(header.counts[section][side]!==counts[section])throw new Error('Comparison original population changed');
 }
 const census=await ctx.sql`SELECT section,count(*)::text AS count FROM control_audit_comparison_items
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${jobId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid GROUP BY section` as {section:ComparisonSection;count:string}[];
 if(census.some(row=>!COMPARISON_SECTIONS.includes(row.section))||new Set(census.map(row=>row.section)).size!==census.length)throw new Error('Comparison output population invalid');
 for(const section of COMPARISON_SECTIONS){const count=header.counts[section],total=Number(census.find(row=>row.section===section)?.count??0);
  if(!Number.isSafeInteger(total)||total!==count.added+count.removed+count.changed)throw new Error('Comparison output population incomplete');}
 return header;
}
