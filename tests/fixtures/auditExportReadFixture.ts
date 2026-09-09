import {randomUUID,createHash} from 'node:crypto';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {buildSnapshotIndex} from '@/modules/accounting/services/controls/auditSnapshotIndexMaterial';
import {renderAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {exportDeliveryRows} from '@/modules/accounting/services/controls/auditExportDeliveryMaterial';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
import type {ExportDeliveryRow} from '@/modules/accounting/services/controls/auditExportDeliveryContract';
/** Genuine authenticated material; queue/storage lifecycle setup is intentionally synthetic. */
export async function exportReadFixture(companyId=randomUUID(),personId=randomUUID(),grantId=randomUUID()){
 const snapshotId=randomUUID(),jobId=randomUUID(),leaseId=randomUUID(),permissions=['read:payroll','read:reports'];
 const artifacts=Array.from({length:105},(_,i)=>({id:`evidence-${String(i).padStart(3,'0')}`,bytes:Buffer.from(`retained original ${i}`)}));
 const sealed=sealAuditSnapshot({version:1,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-09T01:00:00Z',records:[],
  populations:['journal_entry','journal_line','payroll_run','payroll_run_line'].map(source=>({source,count:0,excludedCount:0,exclusions:[]})),checks:[],
  evidence:artifacts.map(a=>({id:a.id,sha256:createHash('sha256').update(a.bytes).digest('hex'),byteLength:a.bytes.length,mediaType:'application/octet-stream'})),coverage:[],missingSources:[]});
 const index=await buildSnapshotIndex(sealed,artifacts,permissions),bundle=await renderAuditEvidence(sealed,artifacts,{companyId,snapshotId});
 const identity={companyId,jobId,leaseId,generation:1,snapshotId,canonicalSnapshotHash:sealed.canonicalHash};
 const rows:ExportDeliveryRow[]=[];for await(const row of exportDeliveryRows(bundle,identity,permissions))rows.push(row);
 const header=rows.find(row=>row.kind==='header')!;if(header.kind!=='header')throw Error('Fixture header missing');
 const request={snapshotId,idempotencyKey:jobId,canonicalSnapshotHash:sealed.canonicalHash,permissions};
 const protected_request=protectChangeValues('audit_job',null,{companyId,jobId,kind:'audit_export',request,
  authority:{personId,authMethod:'pat',connectionId:grantId,grantId,grantedScopes:permissions,actingFirmId:null},
  delegationExpiresAt:'2000-01-01T00:00:00Z'}).protectedPayload;
 return{identity,bundle,rows,request,indexHeader:index.protectedHeader,intentRow:{id:jobId,company_id:companyId,requester_person_id:personId,
  kind:'audit_export',request_hash:auditRequestHash(request),protected_request,generation:1,lease_id:leaseId,protected_header:header.envelope}};
}
