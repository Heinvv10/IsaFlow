import {expect,it} from 'vitest';
import {parseAuditComparisonRequest,parseStoredAuditComparisonRequest} from '@/modules/accounting/services/controls/auditComparisonJobContract';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const request={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:'compare:1'};
const saved={...request,firstCanonicalHash:'a'.repeat(64),secondCanonicalHash:'b'.repeat(64),permissions:['read:invoices','read:reports'],comparisonRuleVersion:1};
it('preserves ordered retained identities, self comparison and caller-independent stored data',()=>{
 expect(parseAuditComparisonRequest(request)).toEqual(request);
 expect(parseAuditComparisonRequest({...request,secondSnapshotId:first}).secondSnapshotId).toBe(first);
 expect(parseAuditComparisonRequest({...request,firstSnapshotId:second,secondSnapshotId:first})).not.toEqual(request);
 const input={...saved,permissions:[...saved.permissions]},result=parseStoredAuditComparisonRequest(input);
 input.permissions.push('write:post');expect(result.permissions).toEqual(saved.permissions);
});
it('rejects public identity, authority, material and resource overrides',()=>{
 for(const field of ['companyId','personId','permissions','firstCanonicalHash','comparisonRuleVersion','maxRecords','deadlineAt'])expect(()=>parseAuditComparisonRequest({...request,[field]:'injected'})).toThrow();
 expect(()=>parseAuditComparisonRequest({...request,firstSnapshotId:'not-a-uuid'})).toThrow();
 expect(()=>parseAuditComparisonRequest({...request,idempotencyKey:'bad key'})).toThrow();
 let called=false;const accessor={...request};Object.defineProperty(accessor,'firstSnapshotId',{enumerable:true,get(){called=true;return first;}});
 expect(()=>parseAuditComparisonRequest(accessor)).toThrow();expect(called).toBe(false);
});
it('requires the exact supported sorted source authority and authenticated hash material',()=>{
 for(const permissions of [[],['read:invoices'],['read:reports','read:reports'],['write:post','read:reports'],['read:reports','read:invoices']])expect(()=>parseStoredAuditComparisonRequest({...saved,permissions})).toThrow();
 for(const invalid of [{firstCanonicalHash:'A'.repeat(64)},{secondCanonicalHash:'short'},{comparisonRuleVersion:2},{companyId:first}])expect(()=>parseStoredAuditComparisonRequest({...saved,...invalid})).toThrow();
 expect(parseStoredAuditComparisonRequest(saved)).toEqual(saved);
});

it('opens only the authenticated comparison kind and preserves ordered source hashes and delegation',async()=>{
 const {randomBytes}=await import('node:crypto');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
 const {protectChangeValues}=await import('@/modules/accounting/services/controls/changeProtection');
 const {openAuditJobRequest,auditRequestHash}=await import('@/modules/accounting/services/controls/auditJobProtection');
 const authority={personId:'person',authMethod:'cookie',connectionId:null,grantId:null,grantedScopes:null,actingFirmId:null};
 const body={companyId:first,jobId:second,kind:'audit_compare',request:saved,authority,delegationExpiresAt:'2026-09-11T00:00:00.000Z'};
 const stored={kind:'audit_compare',company_id:first,id:second,requester_person_id:'person',request_hash:auditRequestHash(saved),protected_request:protectChangeValues('audit_job',null,body).protectedPayload};
 expect(openAuditJobRequest(stored)).toEqual({kind:'audit_compare',request:saved,authority,delegationExpiresAt:body.delegationExpiresAt});
 for(const changed of [{kind:'audit_snapshot'},{kind:'audit_export'},{request_hash:'f'.repeat(64)},{requester_person_id:'other'},{company_id:second}])expect(()=>openAuditJobRequest({...stored,...changed})).toThrow();
});
it('admits a comparison-only cold process result and rejects ambiguous success pointers',async()=>{
 const {decodeAuditProcessReply}=await import('@/modules/accounting/services/controls/auditJobProcessProtocol');
 const value={version:1,result:{state:'succeeded',comparisonId:first,canonicalHash:'c'.repeat(64)}};
 expect(decodeAuditProcessReply(Buffer.from(JSON.stringify(value)))).toEqual(value);
 expect(()=>decodeAuditProcessReply(Buffer.from(JSON.stringify({...value,result:{...value.result,snapshotId:second}})))).toThrow();
});
