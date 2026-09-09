import {expect,it} from 'vitest';
import {extractHistoricalCsvGroups} from '@/modules/accounting/services/controls/historicalImportCsvAdapter';
import {assertLegacyGlRowsMatch} from '@/modules/accounting/services/controls/historicalImportLegacyGlRows';
const group=extractHistoricalCsvGroups(Buffer.from('date,reference,accountCode,debit,credit,description\n2023-02-28,REF,1000,10.01,0,Debit\n2023-02-28,REF,4000,0,10.01,Credit'),{sourceKey:'test',sourceSystem:'csv',kind:'gl'}).groups[0]!;
const rows=[{date:'2023-02-28',reference:'REF',accountCode:'1000',debit:10.01,credit:0,description:'Debit'},
 {date:'2023-02-28',reference:'REF',accountCode:'4000',debit:0,credit:10.01,description:'Credit'}];
it('matches exact complete source population independent of row order',()=>{
 expect(()=>assertLegacyGlRowsMatch([...rows].reverse(),group.normalized!,group.groupKey)).not.toThrow();
});
it('refuses changed descriptions, accounts, dates, references, VAT, dimensions and population',()=>{
 for(const change of [{description:'Other'},{accountCode:'9999'},{date:'2023-03-01'},{reference:'OTHER'},{vatCode:'standard'},{costCentre:'COST'},{debit:10.02}]){
  expect(()=>assertLegacyGlRowsMatch([{...rows[0]!,...change},rows[1]!],group.normalized!,group.groupKey)).toThrow('differs');
 }
 expect(()=>assertLegacyGlRowsMatch(rows.slice(1),group.normalized!,group.groupKey)).toThrow('differs');
 expect(()=>assertLegacyGlRowsMatch([...rows,rows[0]!],group.normalized!,group.groupKey)).toThrow('differs');
});
it('refuses lossy numbers, noncent numbers and undeclared fields instead of normalizing contradictions',()=>{
 for(const debit of [NaN,Infinity,-1,0.001,90071992547409.91])expect(()=>assertLegacyGlRowsMatch([{...rows[0]!,debit},rows[1]!],group.normalized!,group.groupKey)).toThrow();
 expect(()=>assertLegacyGlRowsMatch([{...rows[0]!,ignoredFinancialField:'evil'},rows[1]!],group.normalized!,group.groupKey)).toThrow('differs');
});
it('refuses accessor financial rows without invoking caller code during comparison',()=>{
 let reads=0;const row={...rows[0]!};Object.defineProperty(row,'debit',{enumerable:true,get(){reads++;return 10.01;}});
 expect(()=>assertLegacyGlRowsMatch([row,rows[1]!],group.normalized!,group.groupKey)).toThrow();expect(reads).toBe(0);
});
