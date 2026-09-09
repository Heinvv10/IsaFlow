import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {PDFParse} from 'pdf-parse';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {renderAuditEvidence} from '@/modules/accounting/services/controls/auditEvidenceExportService';
import {verifyAuditEvidenceBundle} from '@/modules/accounting/services/controls/auditEvidenceExportMaterial';
import {renderEvidencePdf} from '@/modules/accounting/services/controls/auditEvidenceExportPdf';
import {verifyAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
const companyId='00000000-0000-4000-8000-000000000001',snapshotId='00000000-0000-4000-8000-000000000002';
const expected={companyId,snapshotId};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function input(count=2){
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-export-key-00000000000000000000000001');
 const bytes=Buffer.from('original evidence\u0000bytes');
 const data={version:1 as const,...expected,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',
  records:Array.from({length:count},(_,i)=>({source:'journal_entry',id:`row-${String(i).padStart(5,'0')}`,version:1,
   data:{amount:'123.45',description:'=FORMULA,"quoted"\nZażółć 中文'}})),
  populations:[{source:'journal_entry',count,excludedCount:1,exclusions:['missing historical classification']}],
  checks:[{checkId:'journal_risk_checks',checkVersion:1,status:'unknown' as const,populationCount:count,excludedCount:1,findingCount:1,
   amountTotals:{gross:'123456789012345678.99'},findings:[{id:'unknown-evidence',message:'original maker absent'}],nextCursor:null,
   coverage:['owned journals'],missingSources:['original approval'],capturedAt:'2026-09-10T01:00:00.000Z',cutoff:'2026-09-09',
   sourceVersions:[{entityType:'journal_entry',entityId:'row-00000',version:1,fingerprint:hash(bytes)}]}],
  evidence:[{id:'../../source',sha256:hash(bytes),byteLength:bytes.length,mediaType:'application/octet-stream'}],
  coverage:['owned journals'],missingSources:['original approval']};
 return{data,sealed:sealAuditSnapshot(data),artifacts:[{id:'../../source',bytes}]};
}
afterEach(()=>vi.unstubAllEnvs());
it('exports every retained record, complete checks and original bytes with authenticated manifest',async()=>{
 const value=input(1002),bundle=await renderAuditEvidence(value.sealed,value.artifacts,expected);
 const manifest=verifyAuditEvidenceBundle(bundle,expected);
 expect(manifest.canonicalSnapshotHash).toBe(value.sealed.canonicalHash);
 expect(manifest.populations[0]!.count).toBe(1002);
 expect(manifest.checks[0]!.amountTotals.gross).toBe('123456789012345678.99');
 expect(manifest.checks[0]!.status).toBe('unknown');expect(manifest.missingSources).toContain('original approval');
 const file=(name:string)=>bundle.files.find(f=>f.path===name)!;
 expect(Buffer.from(file('snapshot.json').bytes).toString()).toBe(value.sealed.canonicalData);
 const csv=Buffer.from(file('records.csv').bytes).toString();
 expect(csv.match(/row-\d{5}/g)).toHaveLength(1002);expect(csv).toContain('row-01001');
 expect(Buffer.from(file('checks.csv').bytes).toString()).toContain('original maker absent');
 expect(file('evidence/000001.bin').bytes).toEqual(new Uint8Array(value.artifacts[0]!.bytes));
 expect(manifest.evidence[0]!.id).toBe('../../source');
 const pdf=file('evidence.pdf');expect(Buffer.from(pdf.bytes).subarray(0,5).toString()).toBe('%PDF-');
 const parser=new PDFParse({data:new Uint8Array(pdf.bytes)});
 try{const text=(await parser.getText()).text;
  expect(text).toContain('row-00000');expect(text).toContain('row-01001');
  expect(text.match(/row-\d{5}/g)!.filter(id=>id!=='row-00000')).toHaveLength(1001);
  expect(text).toContain('123456789012345678.99');expect(text).toContain('unknown-evidence');
 }finally{await parser.destroy();}
},30000);
it('rejects modified output and foreign identity while detaching source bytes',async()=>{
 const value=input(),bundle=await renderAuditEvidence(value.sealed,value.artifacts,expected);
 value.artifacts[0]!.bytes.fill(0);
 expect(()=>verifyAuditEvidenceBundle(bundle,expected)).not.toThrow();
 expect(()=>verifyAuditEvidenceBundle(bundle,{...expected,companyId:snapshotId})).toThrow();
 bundle.files[0]!.bytes[0]^=1;expect(()=>verifyAuditEvidenceBundle(bundle,expected)).toThrow();
});
it('refuses missing evidence and accessor envelope before invoking caller code',async()=>{
 const value=input();let calls=0;
 await expect(renderAuditEvidence(value.sealed,[],expected)).rejects.toThrow(/artifact/i);
 await expect(renderAuditEvidence({...value.sealed,get canonicalData(){calls++;return value.sealed.canonicalData;}},value.artifacts,expected)).rejects.toThrow();
 expect(calls).toBe(0);
});
it('keeps the complete signed snapshot recoverable from separate JSON and seal metadata',async()=>{
 const value=input(),bundle=await renderAuditEvidence(value.sealed,value.artifacts,expected);
 const decode=(path:string)=>Buffer.from(bundle.files.find(file=>file.path===path)!.bytes).toString();
 const metadata=JSON.parse(decode('snapshot-seal.json'));
 expect(metadata).not.toHaveProperty('canonicalData');
 expect(verifyAuditSnapshot({...metadata,canonicalData:decode('snapshot.json')},expected)).toEqual(JSON.parse(value.sealed.canonicalData));
});
it('rejects a missing rendered file and manifest tampering independently of plain output hashes',async()=>{
 const value=input(),bundle=await renderAuditEvidence(value.sealed,value.artifacts,expected);
 const reduced={...bundle,files:bundle.files.slice(1)};
 expect(()=>verifyAuditEvidenceBundle(reduced,expected)).toThrow(/population/);
 const changed=JSON.parse(bundle.manifest.canonicalData);changed.missingSources=[];
 bundle.manifest.canonicalData=JSON.stringify(changed);bundle.manifest.canonicalHash=hash(Buffer.from(bundle.manifest.canonicalData));
 expect(()=>verifyAuditEvidenceBundle(bundle,expected)).toThrow(/authentication/);
});
it('refuses an expired rendering deadline instead of returning a partial PDF',async()=>{
 const value=input(),snapshot=verifyAuditSnapshot(value.sealed,expected);
 await expect(renderEvidencePdf(snapshot,value.sealed.canonicalHash,Date.now()-1)).rejects.toThrow(/runtime/);
});
