import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createComparisonProjection} from '@/modules/accounting/services/controls/auditComparisonProjectionMaterial';
import {sealAuditSnapshot,verifyAuditSnapshot,type AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {makeComparisonItem} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
const companyId='00000000-0000-4000-8000-000000000001',snapshotId='00000000-0000-4000-8000-000000000002',expected={companyId,snapshotId};
afterEach(()=>vi.unstubAllEnvs());
function body():AuditSnapshotData{
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-projection-key-00000000000000000000');
 return{version:1,...expected,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',records:[{source:'journal_entry',id:'z',version:1,data:{secret:'not-in-projection'}},{source:'journal_line',id:'a',version:1,data:{}}],populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]},{source:'journal_line',count:1,excludedCount:0,exclusions:[]}],checks:[],evidence:[{id:'original',sha256:'a'.repeat(64),byteLength:100,mediaType:'application/octet-stream'}],evidenceGaps:[],coverage:[],missingSources:[]};
}
it('authenticates the seal and expected identity, not an adjacent replaced hash or claimed permissions',async()=>{
 const sealed=sealAuditSnapshot(body());
 const canonicalData=sealed.canonicalData.replace('not-in-projection','changed');
 await expect(createComparisonProjection({...sealed,canonicalData,canonicalHash:createHash('sha256').update(canonicalData).digest('hex')},expected,['read:reports'])).rejects.toThrow();
 await expect(createComparisonProjection(sealed,{...expected,companyId:snapshotId},['read:reports'])).rejects.toThrow();
 await expect(createComparisonProjection(sealed,expected,[])).rejects.toThrow();
 await expect(createComparisonProjection(sealed,expected,['read:reports','read:payroll'])).rejects.toThrow();
 const payroll=body();payroll.populations.push(...['payroll_run','payroll_run_line'].map(source=>({source,count:0,excludedCount:0,exclusions:[]})));
 await expect(createComparisonProjection(sealAuditSnapshot(payroll),expected,['read:reports'])).rejects.toThrow();
 expect((await createComparisonProjection(sealAuditSnapshot(payroll),expected,['read:reports','read:payroll'])).permissions).toEqual(['read:payroll','read:reports']);
});
it('sorts identities independently while preserving original ordinals and needs no artifact bytes',async()=>{
 const sealed=sealAuditSnapshot(body()),verified=verifyAuditSnapshot(sealed,expected);
 const projection=await createComparisonProjection(sealed,expected,['read:reports']);
 expect(projection.sections.records.map(row=>row.ordinal)).toEqual([1,0]);
 for(const item of projection.sections.records)expect(item).toEqual(makeComparisonItem('records',verified.records[item.ordinal],item.ordinal));
 expect(projection.counts).toEqual({records:2,checks:0,evidence:1,evidenceGaps:0});
 expect(JSON.stringify(projection)).not.toContain('not-in-projection');
 expect(Object.isFrozen(projection.sections.records[0]!.identity)).toBe(true);expect(Object.isFrozen(projection.permissions)).toBe(true);
});
it('includes full findings in check hashes but excludes only capturedAt',async()=>{
 const data=body();data.checks=[{checkId:'journal_risk_checks',checkVersion:1,status:'fail',populationCount:2,excludedCount:0,findingCount:1,amountTotals:{},findings:[{id:'risk',amount:'115'}],nextCursor:null,coverage:[],missingSources:[],capturedAt:data.capturedAt,cutoff:data.cutoff,sourceVersions:[]}];
 const first=await createComparisonProjection(sealAuditSnapshot(data),expected,['read:reports']);
 data.checks[0]!.capturedAt='2026-09-11T01:00:00.000Z';
 const second=await createComparisonProjection(sealAuditSnapshot(data),expected,['read:reports']);
 expect(second.sections.checks[0]).toEqual(first.sections.checks[0]);
 data.checks[0]!.findings[0]!.amount='116';
 expect((await createComparisonProjection(sealAuditSnapshot(data),expected,['read:reports'])).sections.checks[0]!.materialHash).not.toBe(first.sections.checks[0]!.materialHash);
});
it('refuses expired deadlines and observes actual timer abort during projection',async()=>{
 const data=body();data.records=Array.from({length:2000},(_,n)=>({source:'journal_entry',id:String(n),version:1,data:{}}));data.populations[0]!.count=2000;data.populations[1]!.count=0;
 const sealed=sealAuditSnapshot(data);
 await expect(createComparisonProjection(sealed,expected,['read:reports'],{deadlineAt:Date.now()-1})).rejects.toThrow(/deadline/i);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),0);
 try{await expect(createComparisonProjection(sealed,expected,['read:reports'],{signal:controller.signal})).rejects.toThrow(/abort/i);}finally{clearTimeout(timer);}
});
