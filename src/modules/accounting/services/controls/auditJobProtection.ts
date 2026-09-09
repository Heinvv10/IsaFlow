import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import {parseAuditSnapshotRequest} from './auditJobContract';
const authority=z.object({personId:z.string().min(1),authMethod:z.enum(['cookie','pat','oauth']),
 connectionId:z.string().uuid().nullable(),grantId:z.string().uuid().nullable(),
 grantedScopes:z.array(z.string()).nullable(),actingFirmId:z.string().nullable()}).strict();
export type AuditJobAuthority=z.infer<typeof authority>;
export function auditRequestHash(request:unknown):string{return createHash('sha256').update(canonicalJson(request)).digest('hex');}
/** Authenticated ciphertext binds mutable database metadata to its original request and delegation. */
export function openAuditJobRequest(row:{company_id:string;id:string;requester_person_id:string;request_hash:string;protected_request:ProtectedChange}){
 const body=openProtectedChange(row.protected_request).after;
 if(!body||body.companyId!==row.company_id||body.jobId!==row.id||body.kind!=='audit_snapshot')throw new Error('Audit job evidence identity changed');
 const request=parseAuditSnapshotRequest(body.request),identity=authority.parse(body.authority);
 if(identity.personId!==row.requester_person_id||auditRequestHash(request)!==row.request_hash)throw new Error('Audit job request evidence changed');
 if(identity.authMethod!=='cookie'&&(!identity.connectionId||!identity.grantId||!identity.grantedScopes))throw new Error('Audit job grant evidence is missing');
 if(typeof body.delegationExpiresAt!=='string'||!Number.isFinite(Date.parse(body.delegationExpiresAt)))throw new Error('Audit job delegation expiry is missing');
 return{request,authority:identity,delegationExpiresAt:body.delegationExpiresAt};
}
