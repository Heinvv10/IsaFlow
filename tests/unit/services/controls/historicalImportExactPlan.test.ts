import {describe,it,expect} from 'vitest';
import {normalizeHistoricalImport,parseHistoricalImportArtifact} from '@/modules/accounting/services/controls/historicalImportExactPlan';
const source=()=>({version:1,sourceSystem:'csv',sourceKey:'example',kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records:[
 {recordId:'1',accountCode:'1000',debit:'100.01',credit:'0',description:'Synthetic debit'},
 {recordId:'2',accountCode:'4000',debit:'0',credit:'100.01',description:'Synthetic credit'}]});
describe('historical import exact persisted source normalization',()=>{
 it('normalizes exact cents and stable record order from actual artifact bytes',()=>{
  const input=source();input.records.reverse();
  const normalized=normalizeHistoricalImport(input);
  expect(normalized.records.map(r=>r.recordId)).toEqual(['1','2']);
  expect(normalized.amount).toBe('100.01');
  expect(parseHistoricalImportArtifact(Buffer.from(JSON.stringify(input)),'application/json')).toEqual(normalized);
 });
 it.each(['USD','',null])('refuses unsupported or unknown source currency %s',currency=>{
  expect(()=>normalizeHistoricalImport({...source(),currency})).toThrow('currency');
 });
 it('refuses a one-cent imbalance and never rounds it into balance',()=>{
  const input=source();input.records[1]!.credit='100';expect(()=>normalizeHistoricalImport(input)).toThrow('balance');
 });
 it.each([100.01,'100.001','NaN','-1','1e40'])('refuses unsafe source money %s',debit=>{
  const input=source();expect(()=>normalizeHistoricalImport({...input,records:[{...input.records[0],debit},input.records[1]]})).toThrow();
 });
 it('refuses duplicate record identities, extra fields, too many lines and mixed dates',()=>{
  const input=source();expect(()=>normalizeHistoricalImport({...input,records:[input.records[0],input.records[0]]})).toThrow();
  expect(()=>normalizeHistoricalImport({...input,skipControls:true})).toThrow();
  expect(()=>normalizeHistoricalImport({...input,records:Array.from({length:1001},()=>input.records[0])})).toThrow('bound');
  expect(()=>normalizeHistoricalImport({...input,accountingDate:'2023-02-29'})).toThrow('date');
 });
 it('refuses hash-only, empty, oversized, corrupt or unsupported actual artifacts',()=>{
  for(const bytes of [Buffer.alloc(0),Buffer.from('{"sha256":"'+'a'.repeat(64)+'"}'),Buffer.from('{'),Buffer.alloc(5242881)]){
   expect(()=>parseHistoricalImportArtifact(bytes,'application/json')).toThrow();
  }
  expect(()=>parseHistoricalImportArtifact(Buffer.from('%PDF-1.4'),'application/pdf')).toThrow('extractor');
 });
 it('requires an exact document for an invoice group and refuses fabricated paid status',()=>{
  expect(()=>normalizeHistoricalImport({...source(),kind:'customer_invoice'})).toThrow('document');
  expect(()=>normalizeHistoricalImport({...source(),mode:'attach_subledger'})).toThrow();
 });
});
it('normalizes actual CSV bytes with quoted cells and rejects mixed group metadata',()=>{
 const header='sourceSystem,sourceKey,kind,mode,accountingDate,currency,recordId,accountCode,debit,credit,description';
 const first='csv,SOURCE,gl,post_journal,2023-02-28,ZAR,1,1000,100.01,0,"Quoted, debit"';
 const second='csv,SOURCE,gl,post_journal,2023-02-28,ZAR,2,4000,0,100.01,Credit';
 const normalized=parseHistoricalImportArtifact(Buffer.from([header,first,second].join('\r\n')),'text/csv');
 expect(normalized.amount).toBe('100.01');expect(normalized.records[0]?.description).toBe('Quoted, debit');
 expect(()=>parseHistoricalImportArtifact(Buffer.from([header,first,second.replace('2023-02-28','2023-03-01')].join('\n')),'text/csv')).toThrow('group');
 expect(()=>parseHistoricalImportArtifact(Buffer.from([header,first+'"',second].join('\n')),'text/csv')).toThrow();
});
