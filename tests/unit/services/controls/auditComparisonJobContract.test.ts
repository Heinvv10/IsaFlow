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
