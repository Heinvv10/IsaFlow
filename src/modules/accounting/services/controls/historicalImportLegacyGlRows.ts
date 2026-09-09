import Decimal from 'decimal.js';
import {canonicalJson} from './canonical';
import {importMoney} from './historicalImportExactPlan';
import type {HistoricalImportNormalized} from './historicalImportTypes';
const D=Decimal.clone({precision:80});
const fields=['date','reference','accountCode','debit','credit','description','vatCode','costCentre'];
function money(value:unknown):string{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Legacy GL money differs from exact source');
 const cents=new D(String(value)).mul(100);
 if(!cents.isInteger()||cents.gt(Number.MAX_SAFE_INTEGER))throw new Error('Legacy GL money differs from exact cent bounds');
 return importMoney(String(value));
}
/** The legacy body is an assertion against protected evidence, never posting material. */
export function assertLegacyGlRowsMatch(rows:unknown,source:HistoricalImportNormalized,groupKey:string):void{
 canonicalJson(rows);
 if(source.kind!=='gl'||source.mode!=='post_journal'||!Array.isArray(rows)||rows.length!==source.records.length)throw new Error('Legacy GL population differs from saved source');
 const actual=rows.map((value:unknown)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Legacy GL row differs from saved source');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!fields.includes(key))||typeof row.date!=='string'||row.date!==source.accountingDate
   ||(row.reference!==undefined&&typeof row.reference!=='string')||canonicalJson([row.date,row.reference??''])!==groupKey
   ||typeof row.accountCode!=='string'||typeof row.description!=='string'
   ||(row.vatCode!==undefined&&typeof row.vatCode!=='string')||(row.costCentre!==undefined&&row.costCentre!==''))throw new Error('Legacy GL row differs from saved source');
  return canonicalJson({accountCode:row.accountCode,debit:money(row.debit),credit:money(row.credit),description:row.description,
   ...(row.vatCode?{vatType:row.vatCode}:{})});
 }).sort();
 const expected=source.records.map(({recordId:_recordId,...line})=>canonicalJson(line)).sort();
 if(canonicalJson(actual)!==canonicalJson(expected))throw new Error('Legacy GL body differs from saved source');
}
