import {expect,it} from 'vitest';
import {extractHistoricalCsvGroups} from '@/modules/accounting/services/controls/historicalImportCsvAdapter';
const options={sourceKey:'original-upload',sourceSystem:'csv' as const,kind:'gl' as const};
const header='date,reference,accountCode,debit,credit,description';
const row=(date:string,account:string,debit:string,credit:string,description='Original')=>`${date},REF,${account},${debit},${credit},${description}`;
const bytes=(rows:string[])=>Buffer.from([header,...rows].join('\r\n'));
it('extracts every original multi-date group without converting exact money to Number',()=>{
 const result=extractHistoricalCsvGroups(bytes([row('2023-01-31','1000','90071992547409.91','0'),row('2023-01-31','4000','0','90071992547409.91'),row('2023-02-28','1000','10','0'),row('2023-02-28','4000','0','10')]),options);
 expect(result.recordCount).toBe(4);expect(result.groups).toHaveLength(2);expect(result.invalidGroupCount).toBe(0);
 expect(result.groups[0]?.normalized?.amount).toBe('90071992547409.91');
 expect(result.groups.map(g=>g.normalized?.accountingDate)).toEqual(['2023-01-31','2023-02-28']);
});
it('preserves quotes, commas, multiline cells, BOM and explicit semicolon dialect',()=>{
 const original='\ufeffdate;reference;accountCode;debit;credit;description\r\n2023-01-31;REF;1000;10;0;"First, line\nsecond ""quote"""\r\n2023-01-31;REF;4000;0;10;Credit';
 const result=extractHistoricalCsvGroups(Buffer.from(original),{...options,delimiter:';' });
 expect(result.groups[0]?.normalized?.records[0]?.description).toBe('First, line\nsecond "quote"');
});
it('reports an unbalanced complete group without silently omitting it',()=>{
 const result=extractHistoricalCsvGroups(bytes([row('2023-01-31','1000','10','0'),row('2023-01-31','4000','0','9'),row('2023-02-28','1000','20','0'),row('2023-02-28','4000','0','20')]),options);
 expect(result.recordCount).toBe(4);expect(result.invalidGroupCount).toBe(1);expect(result.groups[0]).toMatchObject({normalized:null,error:expect.stringContaining('balance')});expect(result.groups[1]?.normalized?.amount).toBe('20');
});
it('refuses malformed input, duplicate columns, bad UTF8 and unsupported dimensions instead of discarding data',()=>{
 for(const source of [header+',date\n',header+'\n"unterminated',header+'\n'+row('2023-01-31','1000','','0'),header+',costCentre\n'+row('2023-01-31','1000','10','0')+',COST']){
  const run=()=>extractHistoricalCsvGroups(Buffer.from(source),options);
  if(source.includes(',costCentre'))expect(run).toThrow('dimension');
  else if(source.includes(',,0'))expect(run().invalidGroupCount).toBe(1);else expect(run).toThrow();
 }
 expect(()=>extractHistoricalCsvGroups(Buffer.from([0xff,0xfe]),options)).toThrow('UTF');
});
it('refuses more than 100 groups and binds explicit column mappings without ignored financial columns',()=>{
 const rows=Array.from({length:101},(_,i)=>[`2023-01-31,R${i},1000,1,0,D`,`2023-01-31,R${i},4000,0,1,C`]).flat();
 expect(()=>extractHistoricalCsvGroups(bytes(rows),options)).toThrow('group bound');
 const result=extractHistoricalCsvGroups(Buffer.from('When,Ref,Code,Dr,Cr,Text\n2023-01-31,A,1000,1,0,D\n2023-01-31,A,4000,0,1,C'),{...options,columnMap:{date:'When',reference:'Ref',accountCode:'Code',debit:'Dr',credit:'Cr',description:'Text'}});
 expect(result.groups[0]?.normalized?.amount).toBe('1');
});
