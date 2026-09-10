import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx,ControlFinding} from './contracts';
import {canonicalJson} from './canonical';
import type {ProtectedChange} from './changeProtection';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import {openAuditJobRequest} from './auditJobProtection';
import {auditCheckRunPermissions} from './auditCheckRunContract';
import {openAuditCheckRunHeader,openAuditCheckRunItem,type CheckRunHeader} from './auditCheckRunProtection';
interface HeaderRow {id:string;company_id:string;requester_person_id:string;kind:string;request_hash:string;protected_request:ProtectedChange;
 generation:number|string;lease_id:string;protected_header:SnapshotIndexEnvelope;finding_total:string}
/**
 * Current readers keep access after the original execution delegation expires, and are re-authorised here: no page is
 * served on the strength of a stored permission list alone. Reading never starts work.
 */
export async function readAuditCheckRunHeader(ctx:ControlTx,checkRunId:string):Promise<CheckRunHeader>{
 assertControlTx(ctx);const jobId=z.string().uuid().parse(checkRunId).toLowerCase();
 await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT i.id,i.company_id,i.requester_person_id,i.kind,i.request_hash,i.protected_request,
  j.generation,r.lease_id,r.protected_header,
  (SELECT count(*)::text FROM control_audit_check_findings f WHERE f.company_id=r.company_id AND f.job_id=r.job_id
    AND f.generation=r.generation AND f.lease_id=r.lease_id) AS finding_total
  FROM control_audit_jobs j
  JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  JOIN control_audit_check_results r ON r.company_id=j.company_id AND r.job_id=j.job_id AND r.generation=j.generation
  WHERE j.company_id=${ctx.principal.companyId}::uuid AND j.job_id=${jobId}::uuid
   AND j.state='succeeded' AND j.result_check_run_id=j.job_id` as HeaderRow[];
 const row=rows[0];if(rows.length!==1||!row)throw new Error('Completed check run unavailable');
 const saved=openAuditJobRequest(row);if(saved.kind!=='audit_check_run')throw new Error('Check run retained request kind changed');
 // The caller's CURRENT permissions, derived from the retained check id rather than trusted from the stored list.
 for(const permission of auditCheckRunPermissions(saved.request.checkId))await assertEffectivePermission(ctx,permission);
 const header=openAuditCheckRunHeader(row.protected_header,{companyId:ctx.principal.companyId,checkRunId:jobId,
  generation:Number(row.generation),leaseId:row.lease_id});
 if(header.checkId!==saved.request.checkId||header.cutoff!==saved.request.cutoff
  ||canonicalJson(header.permissions)!==canonicalJson(auditCheckRunPermissions(saved.request.checkId)))throw new Error('Check run retained request changed');
 if(Number(row.finding_total)!==header.findingCount)throw new Error('Check run output population incomplete');
 return header;
}
const pageSchema=z.object({checkRunId:z.string().uuid().transform(id=>id.toLowerCase()),
 limit:z.number().int().min(1).max(100).default(100),cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
/** Findings page by ordinal, bound to the generation and lease the published header names; every seal is verified. */
export async function getAuditCheckRunPage(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const request=pageSchema.parse(JSON.parse(canonicalJson(input)));
 const header=await readAuditCheckRunHeader(ctx,request.checkRunId),start=Number(request.cursor??0);
 if(start>header.findingCount)throw new Error('Invalid check run page cursor');
 const rows=await ctx.sql`WITH candidates AS (
  SELECT ordinal,protected_item FROM control_audit_check_findings
  WHERE company_id=${ctx.principal.companyId}::uuid AND job_id=${request.checkRunId}::uuid
   AND generation=${header.generation} AND lease_id=${header.leaseId}::uuid AND ordinal>=${start} ORDER BY ordinal LIMIT ${request.limit}
 ), bounded AS (SELECT ordinal,protected_item,sum(octet_length(protected_item::text)) OVER(ORDER BY ordinal) AS bytes FROM candidates)
 SELECT ordinal,protected_item FROM bounded WHERE bytes<=2097152 ORDER BY ordinal` as {ordinal:number;protected_item:SnapshotIndexEnvelope}[];
 // A sealed finding fits the byte budget at the maximum page size. Never conceal omitted rows.
 if(rows.length!==Math.min(request.limit,header.findingCount-start))throw new Error('Check run page incomplete or encrypted byte budget exceeded');
 const findings:ControlFinding[]=rows.map((row,index)=>{
  if(row.ordinal!==start+index)throw new Error('Check run page ordinal changed');
  return openAuditCheckRunItem(row.protected_item,header,row.ordinal).finding;
 });
 const next=start+findings.length;
 return{version:header.version,companyId:header.companyId,checkRunId:request.checkRunId,generation:header.generation,
  canonicalHash:header.canonicalHash,permissions:header.permissions,checkId:header.checkId,checkVersion:header.checkVersion,
  cutoff:header.cutoff,status:header.status,populationCount:header.populationCount,excludedCount:header.excludedCount,
  findingCount:header.findingCount,populationCountBasis:header.populationCountBasis,amountTotals:header.amountTotals,
  coverage:header.coverage,missingSources:header.missingSources,populationDigest:header.populationDigest,
  sourceVersions:{available:false,reason:'deferred_paged_source_versions',count:header.sourceVersionCount},
  findings,nextCursor:next<header.findingCount?String(next):null};
}
