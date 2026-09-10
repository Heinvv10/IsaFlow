import {expect,it} from 'vitest';
import {parseDeferredAuditComparisonRequest} from '@/modules/accounting/services/controls/auditComparisonDeferredContract';
import {parseAuditComparisonRequest,parseStoredAuditComparisonRequest} from '@/modules/accounting/services/controls/auditComparisonJobContract';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const publicRequest={firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:'legacy:1'};
const saved={...publicRequest,requestVersion:2,sourceVerification:'worker',comparisonRuleVersion:1,permissions:['read:payroll','read:reports'],
 firstSource:{snapshotId:first,sourceJobId:first,sourceRequestHash:'a'.repeat(64)},secondSource:{snapshotId:second,sourceJobId:second,sourceRequestHash:'b'.repeat(64)}};
it('retains distinct authenticated intent anchors without claiming verified content hashes',()=>{
 const parsed=parseDeferredAuditComparisonRequest(saved);expect(parsed).toEqual(saved);
 expect(parsed).not.toHaveProperty('firstCanonicalHash');expect(parsed).not.toHaveProperty('secondCanonicalHash');
 const input={...saved,firstSource:{...saved.firstSource},permissions:[...saved.permissions]},detached=parseDeferredAuditComparisonRequest(input);
 input.firstSource.sourceRequestHash='c'.repeat(64);input.permissions.push('write:post');expect(detached).toEqual(saved);
});
it('binds ordered anchors and rejects ambiguous versions, content hash claims and caller authority',()=>{
 for(const patch of [{requestVersion:1},{sourceVerification:'verified'},{firstSource:saved.secondSource},{permissions:['read:reports','read:payroll']},
  {firstCanonicalHash:'c'.repeat(64)},{companyId:first},{firstSource:{...saved.firstSource,sourceRequestHash:'bad'}},
  {secondSource:{...saved.secondSource,personId:'injected'}},{comparisonRuleVersion:2}])expect(()=>parseDeferredAuditComparisonRequest({...saved,...patch})).toThrow();
 expect(()=>parseAuditComparisonRequest(saved)).toThrow();
});
it('allows self comparison only with identical original request anchors',()=>{
 expect(parseDeferredAuditComparisonRequest({...saved,secondSnapshotId:first,secondSource:saved.firstSource})).toMatchObject({secondSnapshotId:first});
 expect(()=>parseDeferredAuditComparisonRequest({...saved,secondSnapshotId:first,secondSource:{...saved.firstSource,sourceRequestHash:'c'.repeat(64)}})).toThrow();
});
it('keeps original hash-pinned stored requests and public requests unchanged',()=>{
 expect(parseAuditComparisonRequest(publicRequest)).toEqual(publicRequest);
 const original={...publicRequest,firstCanonicalHash:'a'.repeat(64),secondCanonicalHash:'b'.repeat(64),permissions:['read:reports'],comparisonRuleVersion:1};
 expect(parseStoredAuditComparisonRequest(original)).toEqual(original);
});
it('treats UUID case variants as one database identity before comparing source anchors',()=>{
 const lower='abcdefab-1234-4123-8123-abcdefabcdef',upper=lower.toUpperCase();
 const same={...saved,firstSnapshotId:lower,secondSnapshotId:upper,
  firstSource:{...saved.firstSource,snapshotId:lower,sourceJobId:lower},secondSource:{...saved.firstSource,snapshotId:upper,sourceJobId:upper}};
 expect(()=>parseDeferredAuditComparisonRequest({...same,secondSource:{...same.secondSource,sourceRequestHash:'c'.repeat(64)}})).toThrow();
 expect(parseDeferredAuditComparisonRequest(same)).toMatchObject({firstSnapshotId:lower,secondSnapshotId:lower,secondSource:{snapshotId:lower,sourceJobId:lower}});
});
it('opens versioned deferred stored requests while refusing unsupported versions',()=>{
 expect(parseStoredAuditComparisonRequest(saved)).toEqual(saved);
 expect(()=>parseStoredAuditComparisonRequest({...saved,requestVersion:3})).toThrow();
});
