import {afterEach,expect,it,vi} from 'vitest';
import {sealAuditSnapshot,verifyAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {exportAuditEvidence,renderAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {renderEvidencePdf} from '@/modules/accounting/services/controls/auditEvidenceExportPdf';
import {readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
vi.mock('@/modules/accounting/services/controls/auditSnapshotPublication',()=>({readRetainedAuditSnapshot:vi.fn()}));
const expected={companyId:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222'};
function input(count=2000){
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-export-cancel-key-outside-database');
 return sealAuditSnapshot({version:1,...expected,cutoff:'2026-09-09',capturedAt:'2026-09-09T00:00:00.000Z',
  records:Array.from({length:count},(_,i)=>({source:'journal_entry',id:`record-${i}`,version:null,data:{amount:'100.00',description:'Actual renderer cancellation '.repeat(20)}})),
  populations:[{source:'journal_entry',count,excludedCount:0,exclusions:[]}],checks:[],evidence:[],coverage:[],missingSources:[]});
}
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.mocked(readRetainedAuditSnapshot).mockReset();});
it('rejects an expired outer deadline before any retained database read',async()=>{
 await expect(exportAuditEvidence({} as ControlTx,expected.snapshotId,{deadlineAt:Date.now()-1})).rejects.toThrow(/runtime|deadline/i);
 expect(readRetainedAuditSnapshot).not.toHaveBeenCalled();
});
it('does not reset the upstream deadline after retained loading',async()=>{
 const sealed=input(1),deadlineAt=Date.now()+10;
 vi.mocked(readRetainedAuditSnapshot).mockImplementation(async()=>{
  await new Promise(resolve=>setTimeout(resolve,20));return{sealed,snapshot:verifyAuditSnapshot(sealed,expected),artifacts:[]};
 });
 await expect(exportAuditEvidence({principal:expected} as unknown as ControlTx,expected.snapshotId,{deadlineAt})).rejects.toThrow(/runtime|deadline/i);
});
it('observes an actual timer abort while rendering a large complete PDF',async()=>{
 const sealed=input(),snapshot=verifyAuditSnapshot(sealed,expected),controller=new AbortController(),reason=new Error('Synthetic PDF cancellation');
 const timer=setTimeout(()=>controller.abort(reason),5),started=Date.now();
 try{await expect(renderEvidencePdf(snapshot,sealed.canonicalHash,Date.now()+60000,{signal:controller.signal})).rejects.toBe(reason);
  expect(Date.now()-started).toBeLessThan(3000);
 }finally{clearTimeout(timer);}
});
it('observes actual timer abort during complete bundle rendering without returning partial output',async()=>{
 const sealed=input(),controller=new AbortController(),reason=new Error('Synthetic bundle cancellation');
 const timer=setTimeout(()=>controller.abort(reason),5);
 try{await expect(renderAuditEvidence(sealed,[],expected,{signal:controller.signal})).rejects.toBe(reason);}finally{clearTimeout(timer);}
});
