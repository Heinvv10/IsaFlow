import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {sealAuditSnapshot,verifyAuditSnapshot,type AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {compareSealedAuditSnapshots} from '@/modules/accounting/services/controls/auditSnapshotCompare';
import {compareSnapshotStreams,makeComparisonItem,COMPARISON_SECTIONS,type ComparisonItem,type ComparisonChange,type ComparisonSource} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
const companyId='00000000-0000-4000-8000-000000000001',firstId='00000000-0000-4000-8000-000000000002',secondId='00000000-0000-4000-8000-000000000003';
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
afterEach(()=>vi.unstubAllEnvs());
function snapshot(id=firstId):AuditSnapshotData{return{version:1,companyId,snapshotId:id,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',
 records:[{source:'journal_entry',id:'original',version:1,data:{amount:'115.00',classification:'ordinary'}}],populations:[{source:'journal_entry',count:1,excludedCount:0,exclusions:[]}],checks:[],evidence:[],evidenceGaps:[],coverage:[],missingSources:[]};}
async function* stream(items:ComparisonItem[]){yield* items;}
function source(data:AuditSnapshotData):ComparisonSource{
 const sealed=sealAuditSnapshot(data),body=verifyAuditSnapshot(sealed,{companyId,snapshotId:data.snapshotId});
 const sections:ComparisonSource['sections']={records:{count:0,items:stream([])},checks:{count:0,items:stream([])},evidence:{count:0,items:stream([])},evidenceGaps:{count:0,items:stream([])}};
 for(const section of COMPARISON_SECTIONS){const items=(body[section]??[]).map((row,ordinal)=>makeComparisonItem(section,row,ordinal));
  items.sort((a,b)=>canonicalJson(a.identity)<canonicalJson(b.identity)?-1:canonicalJson(a.identity)>canonicalJson(b.identity)?1:0);sections[section]={count:items.length,items:stream(items)};}

 return{id:data.snapshotId,companyId,canonicalHash:sealed.canonicalHash,cutoff:data.cutoff,capturedAt:data.capturedAt,populationsHash:hash(body.populations),coverageHash:hash([body.coverage,body.missingSources]),sections};
}
function signing(){vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-only-snapshot-key-0000000000000000000001');}
it('matches full authenticated oracle for added/removed/changed records, check versions, evidence and gaps',async()=>{
 signing();const a=snapshot(),b=snapshot(secondId);a.records.push({source:'journal_entry',id:'removed',version:1,data:{amount:'3'}});a.populations[0]!.count=2;
 b.records[0]!.version=2;b.records[0]!.data={amount:'115.00',classification:'reversed',entry_date:'2026-09-01'};
 b.records.push({source:'journal_entry',id:'backdated',version:1,data:{amount:'50',entry_date:'2026-09-02'}});b.populations[0]!.count=2;
 a.evidence=[{id:'doc',sha256:'a'.repeat(64),byteLength:5,mediaType:'text/plain'}];b.evidence=[{...a.evidence[0]!,sha256:'b'.repeat(64)}];
 a.evidenceGaps=[{id:'missing',reason:'unknown',relations:[]}];b.evidenceGaps=[{id:'other',reason:'unavailable',relations:[]}];b.coverage=['changed'];
 const check={checkId:'journal_risk_checks',checkVersion:1,status:'pass' as const,populationCount:2,excludedCount:0,findingCount:0,amountTotals:{},findings:[],nextCursor:null,coverage:[],missingSources:[],capturedAt:a.capturedAt,cutoff:a.cutoff,sourceVersions:[]};
 a.checks=[check];b.checks=[{...check,checkVersion:2}];
 const expected=compareSealedAuditSnapshots(companyId,{id:a.snapshotId,sealed:sealAuditSnapshot(a)},{id:b.snapshotId,sealed:sealAuditSnapshot(b)}),changes:ComparisonChange[]=[];
 const summary=await compareSnapshotStreams(source(a),source(b),async change=>{changes.push(change);});
 for(const section of COMPARISON_SECTIONS){const rows=changes.filter(row=>row.section===section);
  expect({added:rows.filter(r=>r.kind==='added').map(r=>r.identity),removed:rows.filter(r=>r.kind==='removed').map(r=>r.identity),changed:rows.filter(r=>r.kind==='changed').map(r=>({...r.identity,beforeHash:r.before!.materialHash,afterHash:r.after!.materialHash}))}).toEqual(expected[section]);
  expect(summary.counts[section].first).toBe((a[section]??[]).length);expect(summary.counts[section].second).toBe((b[section]??[]).length);
 }
 expect(summary.populationChanged).toBe(expected.populationChanged);expect(summary.coverageChanged).toBe(true);
 expect(changes.find(row=>row.kind==='changed')?.before).toMatchObject({snapshotId:firstId,canonicalHash:sealAuditSnapshot(a).canonicalHash});
});
it('self comparison and fresh check capture time cause no changes; all other check fields count',async()=>{
 signing();const a=snapshot(),b=snapshot(secondId),check={checkId:'journal_risk_checks',checkVersion:1,status:'pass' as const,populationCount:1,excludedCount:0,findingCount:0,amountTotals:{},findings:[],nextCursor:null,coverage:[],missingSources:[],capturedAt:a.capturedAt,cutoff:a.cutoff,sourceVersions:[]};a.checks=[check];b.checks=[{...check,capturedAt:'2026-09-11T01:00:00.000Z'}];
 const emitted=vi.fn(async()=>{});await compareSnapshotStreams(source(a),source(a),emitted);await compareSnapshotStreams(source(a),source(b),emitted);expect(emitted).not.toHaveBeenCalled();
 expect(makeComparisonItem('checks',check,0).materialHash).not.toBe(makeComparisonItem('checks',{...check,coverage:['new']},0).materialHash);
});
function synthetic(items:AsyncIterable<ComparisonItem>,count:number):ComparisonSource{return{id:firstId,companyId,canonicalHash:'a'.repeat(64),cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',populationsHash:'b'.repeat(64),coverageHash:'c'.repeat(64),sections:{records:{items,count},checks:{items:stream([]),count:0},evidence:{items:stream([]),count:0},evidenceGaps:{items:stream([]),count:0}}};}
const item=(id:string,ordinal:number)=>makeComparisonItem('records',{source:'journal_entry',id,version:1,data:{}},ordinal);
for(const mode of ['missing','duplicate','out_of_order','duplicate_ordinal'] as const)it(`refuses ${mode} rather than returning complete counts`,async()=>{
 const rows=mode==='missing'?[item('a',0)]:mode==='duplicate'?[item('a',0),item('a',1)]:mode==='out_of_order'?[item('b',0),item('a',1)]:[item('a',0),item('b',0)];
 await expect(compareSnapshotStreams(synthetic(stream(rows),2),synthetic(stream([]),0),async()=>{})).rejects.toThrow();
});
it('consumes only bounded lookahead and awaits the output consumer',async()=>{
 let produced=0,emitted=0,maxAhead=0;
 async function* rows(parity:number){for(let n=0;n<500;n++){produced++;maxAhead=Math.max(maxAhead,produced-emitted);yield item(String(n*2+parity).padStart(6,'0'),n);}}
 const result=await compareSnapshotStreams(synthetic(rows(0),500),synthetic(rows(1),500),async()=>{await Promise.resolve();emitted++;});
 expect(emitted).toBe(1000);expect(maxAhead).toBeLessThanOrEqual(2);expect(result.counts.records).toEqual({first:500,second:500,added:500,removed:500,changed:0,unchanged:0});
});
it('observes real timer cancellation while consuming a large iterator and closes it',async()=>{
 const controller=new AbortController();let produced=0,closed=false;
 async function* rows(){try{for(let n=0;n<5000;n++){produced++;yield item(String(n).padStart(6,'0'),n);}}finally{closed=true;}}
 const timer=setTimeout(()=>controller.abort(new Error('timer abort')),0);
 try{await expect(compareSnapshotStreams(synthetic(rows(),5000),synthetic(stream([]),0),async()=>{},{signal:controller.signal})).rejects.toThrow('timer abort');}
 finally{clearTimeout(timer);}expect(produced).toBeLessThan(5000);expect(closed).toBe(true);
});
it('expired deadline refuses before pulling either input',async()=>{
 let pulled=0;async function* rows(){pulled++;yield item('a',0);}
 await expect(compareSnapshotStreams(synthetic(rows(),1),synthetic(stream([]),0),async()=>{},{deadlineAt:Date.now()-1})).rejects.toThrow(/deadline/i);expect(pulled).toBe(0);
});
it('bounds a stalled input next call by the real deadline and requests iterator cleanup',async()=>{
 let closed=false;
 const stalled:AsyncIterable<ComparisonItem>={[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{}),return:async()=>{closed=true;return{done:true,value:undefined};}})};
 await expect(compareSnapshotStreams(synthetic(stalled,1),synthetic(stream([]),0),async()=>{},{deadlineAt:Date.now()+30})).rejects.toThrow(/deadline/i);expect(closed).toBe(true);
});
it('awaits failed output and closes inputs without returning successful counts',async()=>{
 let closed=false;async function* rows(){try{yield item('a',0);yield item('b',1);}finally{closed=true;}}
 await expect(compareSnapshotStreams(synthetic(rows(),2),synthetic(stream([]),0),async()=>{throw new Error('sink failed');})).rejects.toThrow('sink failed');expect(closed).toBe(true);
});
