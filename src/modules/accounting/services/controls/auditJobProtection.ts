import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parseStoredAuditComparisonRequest,type StoredAuditComparisonRequest} from './auditComparisonJobContract';
import {canonicalJson} from './canonical';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {AUDIT_JOB_KINDS,parseAuditSnapshotRequest,type AuditJobKind,type AuditSnapshotRequest} from './auditJobContract';
import {parseStoredAuditExportRequest,type StoredAuditExportRequest} from './auditExportJobContract';
import {parseStoredAuditCheckRunRequest,type StoredAuditCheckRunRequest} from './auditCheckRunContract';
const authority=z.object({personId:z.string().min(1),authMethod:z.enum(['cookie','pat','oauth']),
 connectionId:z.string().uuid().nullable(),grantId:z.string().uuid().nullable(),
 grantedScopes:z.array(z.string()).nullable(),actingFirmId:z.string().nullable()}).strict();
export type AuditJobAuthority=z.infer<typeof authority>;
export function auditRequestHash(request:unknown):string{return createHash('sha256').update(canonicalJson(request)).digest('hex');}
export type AuthenticatedAuditJobRequest={authority:AuditJobAuthority;delegationExpiresAt:string}&(
 {kind:'audit_snapshot';request:AuditSnapshotRequest}|{kind:'audit_export';request:StoredAuditExportRequest}|{kind:'audit_compare';request:StoredAuditComparisonRequest}
 |{kind:'audit_check_run';request:StoredAuditCheckRunRequest});
const isAuditJobKind=(kind:string):kind is AuditJobKind=>(AUDIT_JOB_KINDS as readonly string[]).includes(kind);
/** Parse dispatch per allowed kind; an unlisted kind never reaches a parser. */
function parseStoredRequest(kind:AuditJobKind,request:unknown){
 return kind==='audit_snapshot'?parseAuditSnapshotRequest(request):kind==='audit_export'?parseStoredAuditExportRequest(request)
  :kind==='audit_compare'?parseStoredAuditComparisonRequest(request):parseStoredAuditCheckRunRequest(request);
}
/** Authenticated ciphertext binds mutable database metadata to its original request and delegation. */
export function openAuditJobRequest(row:{kind:string;company_id:string;id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange}):AuthenticatedAuditJobRequest{
 const body=openProtectedChange(row.protected_request).after;
 if(!body||body.companyId!==row.company_id||body.jobId!==row.id||body.kind!==row.kind||!isAuditJobKind(row.kind))throw new Error('Audit job evidence identity changed');
 const kind=row.kind,request=parseStoredRequest(kind,body.request),identity=authority.parse(body.authority);
 if(identity.personId!==row.requester_person_id||auditRequestHash(request)!==row.request_hash)throw new Error('Audit job request evidence changed');
 if(identity.authMethod!=='cookie'&&(!identity.connectionId||!identity.grantId||!identity.grantedScopes))throw new Error('Audit job grant evidence is missing');
 if(typeof body.delegationExpiresAt!=='string'||!Number.isFinite(Date.parse(body.delegationExpiresAt)))throw new Error('Audit job delegation expiry is missing');
 const common={authority:identity,delegationExpiresAt:body.delegationExpiresAt};
 return kind==='audit_snapshot'?{...common,kind,request:parseAuditSnapshotRequest(request)}
  :kind==='audit_export'?{...common,kind,request:parseStoredAuditExportRequest(request)}
  :kind==='audit_compare'?{...common,kind,request:parseStoredAuditComparisonRequest(request)}
  :{...common,kind,request:parseStoredAuditCheckRunRequest(request)};
}
