import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {openAuditJobRequest,auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
import {parseAuditExportRequest,parseStoredAuditExportRequest} from '@/modules/accounting/services/controls/auditExportJobContract';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const company='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222';
const snapshot='33333333-3333-4333-8333-333333333333';
function row(kind:string,request:unknown){
 const body={companyId:company,jobId:job,kind,request,authority:{personId:'synthetic-person',authMethod:'cookie',connectionId:null,grantId:null,grantedScopes:null,actingFirmId:null},delegationExpiresAt:'2026-09-10T20:00:00.000Z'};
 return{kind,company_id:company,id:job,requester_person_id:'synthetic-person',request_hash:auditRequestHash(request),protected_request:protectChangeValues('audit_job',null,body).protectedPayload};
}
it('public export input cannot choose tenant, authority, hash or permissions',()=>{
 const input={snapshotId:snapshot,idempotencyKey:'export-1'};
 expect(parseAuditExportRequest(input)).toEqual(input);
 for(const extra of [{companyId:company},{permissions:['read:reports']},{canonicalSnapshotHash:'a'.repeat(64)},{personId:'other'}])expect(()=>parseAuditExportRequest({...input,...extra})).toThrow();
});
it('opens authenticated export requests while preserving the legacy snapshot hash interpretation',()=>{
 const request={snapshotId:snapshot,idempotencyKey:'export-1',canonicalSnapshotHash:'a'.repeat(64),permissions:['read:payroll','read:reports']};
 expect(openAuditJobRequest(row('audit_export',request))).toMatchObject({kind:'audit_export',request});
 const legacy={cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:'snapshot-1'};
 expect(openAuditJobRequest(row('audit_snapshot',legacy))).toMatchObject({kind:'audit_snapshot',request:legacy});
});
it('rejects database kind swaps, mismatched request shapes and changed authenticated metadata',()=>{
 const request={snapshotId:snapshot,idempotencyKey:'export-1',canonicalSnapshotHash:'a'.repeat(64),permissions:['read:reports']};
 const stored=row('audit_export',request);
 for(const changed of [{kind:'audit_snapshot'},{kind:'other'},{request_hash:'b'.repeat(64)},{requester_person_id:'other'}])expect(()=>openAuditJobRequest({...stored,...changed})).toThrow();
 expect(()=>openAuditJobRequest(row('audit_snapshot',request))).toThrow();
});
it('bounds stored source permissions and rejects malformed immutable export identity',()=>{
 const input={snapshotId:snapshot,idempotencyKey:'export-1',canonicalSnapshotHash:'a'.repeat(64),permissions:['read:reports']};
 expect(parseStoredAuditExportRequest(input)).toEqual(input);
 for(const extra of [{permissions:[]},{permissions:['write:post','read:reports']},{permissions:['read:reports','read:reports']},{canonicalSnapshotHash:'wrong'},{snapshotId:'bad'}])expect(()=>parseStoredAuditExportRequest({...input,...extra})).toThrow();
});
