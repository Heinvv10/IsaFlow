import {afterEach,expect,it,vi} from 'vitest';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {compareSealedAuditSnapshots} from '@/modules/accounting/services/controls/auditSnapshotCompare';
const companyId='00000000-0000-4000-8000-000000000001';
const firstId='00000000-0000-4000-8000-000000000002',secondId='00000000-0000-4000-8000-000000000003';
function capture(snapshotId=firstId){
 return {version:1 as const,companyId,snapshotId,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',
  records:[{source:'journals',id:'original',version:1,data:{amount:'115.00',classification:'ordinary'}}],
  populations:[{source:'journals',count:1,excludedCount:0,exclusions:[]}],checks:[],evidence:[],coverage:[],missingSources:[]};
}
function compare(first:ReturnType<typeof capture>,second:ReturnType<typeof capture>){
 return compareSealedAuditSnapshots(companyId,{id:first.snapshotId,sealed:sealAuditSnapshot(first)},
  {id:second.snapshotId,sealed:sealAuditSnapshot(second)});
}
afterEach(()=>vi.unstubAllEnvs());
function key(){vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-only-snapshot-key-0000000000000000000001');}
it('identifies a backdated addition without altering the earlier retained snapshot',()=>{
 key();const first=capture(),second=capture(secondId),before=sealAuditSnapshot(first);
 second.records.push({source:'journals',id:'backdated',version:1,data:{amount:'50.00',classification:'ordinary'}});
 second.populations[0]!.count=2;
 const diff=compare(first,second);
 expect(diff.records.added).toEqual([{source:'journals',id:'backdated'}]);
 expect(diff.records.removed).toEqual([]);expect(diff.records.changed).toEqual([]);
 expect(sealAuditSnapshot(first)).toEqual(before);expect(diff.populationChanged).toBe(true);
});
it('identifies edits, reversals and classification changes by full retained data and source version',()=>{
 key();const first=capture(),second=capture(secondId);
 second.records[0]!.version=2;second.records[0]!.data.classification='reversed';
 const diff=compare(first,second);
 expect(diff.records.changed).toHaveLength(1);
 expect(diff.records.changed[0]).toMatchObject({source:'journals',id:'original'});
 expect(diff.records.changed[0]!.beforeHash).not.toBe(diff.records.changed[0]!.afterHash);
 expect(JSON.stringify(diff)).not.toContain('115.00');
});
it('does not classify a new capture time or snapshot identity as an accounting change',()=>{
 key();const first=capture(),second={...capture(secondId),capturedAt:'2026-09-11T01:00:00.000Z'};
 const diff=compare(first,second);
 expect(diff.records).toEqual({added:[],removed:[],changed:[]});expect(diff.populationChanged).toBe(false);
 expect(diff.first.capturedAt).not.toBe(diff.second.capturedAt);
});
it('authenticates both snapshot identities and refuses cross-tenant comparison',()=>{
 key();const first=capture(),second=capture(secondId);
 const a={id:firstId,sealed:sealAuditSnapshot(first)},b={id:secondId,sealed:sealAuditSnapshot(second)};
 expect(()=>compareSealedAuditSnapshots(companyId,a,{...b,id:firstId})).toThrow();
 expect(()=>compareSealedAuditSnapshots('00000000-0000-4000-8000-000000000004',a,b)).toThrow();
});
it('reports changed check versions but ignores a fresh observation time alone',()=>{
 key();const check={checkId:'journal_risk_checks',checkVersion:1,status:'pass',populationCount:1,excludedCount:0,
  findingCount:0,amountTotals:{},findings:[],nextCursor:null,coverage:[],missingSources:[],
  capturedAt:'2026-09-10T01:00:00.000Z',cutoff:'2026-09-09',sourceVersions:[]};
 const first={...capture(),checks:[check]};
 const second={...capture(secondId),checks:[{...check,capturedAt:'2026-09-11T01:00:00.000Z'}]};
 const invoke=()=>compareSealedAuditSnapshots(companyId,{id:firstId,sealed:sealAuditSnapshot(first)},
  {id:secondId,sealed:sealAuditSnapshot(second)});
 expect(invoke().checks.changed).toEqual([]);
 second.checks[0]!.checkVersion=2;expect(invoke().checks.changed).toHaveLength(1);
});
it('rejects reference getters before verification or returned hash metadata can reread them',()=>{
 key();const sealed=sealAuditSnapshot(capture());let reads=0;
 const first={id:firstId,get sealed(){reads++;return sealed;}};
 expect(()=>compareSealedAuditSnapshots(companyId,first,{id:firstId,sealed})).toThrow();
 expect(reads).toBe(0);
});
