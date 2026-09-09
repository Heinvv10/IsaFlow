import Decimal from 'decimal.js';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {requireControlTx} from './context';
import {canonicalJson} from './canonical';
import {assertHistoricalImportAuthority} from './historicalImportAuthority';
import {readHistoricalImportSource} from './historicalImportSourceService';
import {assertLegacyGlRowsMatch} from './historicalImportLegacyGlRows';
import {executeHistoricalImport} from './historicalImportExecution';
import type {ImportResult,ImportRow} from '../gl/glImportService';
export interface HistoricalGlImportBindings {imports:Array<{importId:string;approvalId:string}>}
const D=Decimal.clone({precision:80});
/** Legacy numeric rows assert a saved original CSV group; they never supply posting amounts. */
export async function executeLegacyHistoricalGl(companyId:string,rows:ImportRow[],userId:string,input?:HistoricalGlImportBindings):Promise<ImportResult>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Historical import actor differs from authenticated request');
 if(!input)throw new Error('Historical GL posting requires saved independently approved imports');
 // Freeze caller assertions before any await, retaining descriptor and finite-number checks.
 const bindings=JSON.parse(canonicalJson(input)) as HistoricalGlImportBindings;
 const frozenRows=JSON.parse(canonicalJson(rows)) as ImportRow[];
 if(Object.keys(bindings).some(key=>key!=='imports')||!Array.isArray(bindings.imports)||bindings.imports.length<1||bindings.imports.length>100
  ||new Set(bindings.imports.map(item=>item?.importId)).size!==bindings.imports.length
  ||bindings.imports.some(item=>!item||Object.keys(item).some(key=>!['importId','approvalId'].includes(key))||!UUID_RE.test(item.importId)||!UUID_RE.test(item.approvalId)))throw new Error('Invalid saved historical GL import bindings');
 if(!Array.isArray(frozenRows)||frozenRows.length<2||frozenRows.length>100000)throw new Error('Legacy GL population differs from saved source bounds');
 const groups=new Map<string,ImportRow[]>();
 for(const row of frozenRows){
  if(!row||typeof row!=='object'||typeof row.date!=='string'||(row.reference!==undefined&&typeof row.reference!=='string'))throw new Error('Legacy GL row differs from saved source');
  const key=canonicalJson([row.date,row.reference??'']);const group=groups.get(key)??[];group.push(row);groups.set(key,group);
 }
 if(groups.size!==bindings.imports.length)throw new Error('Legacy GL groups differ from saved source');
 await assertHistoricalImportAuthority(ctx,'gl','write');
 return withSavepoint('historical_legacy_gl',async()=>{
  const seen=new Set<string>();let total=new D(0),lineCount=0;
  for(const binding of bindings.imports){
   const intents=await ctx.sql`SELECT source_id,requester_person_id,kind,mode FROM control_historical_imports
    WHERE company_id=${companyId}::uuid AND id=${binding.importId}::uuid` as {source_id:string;requester_person_id:string;kind:string;mode:string}[];
   const intent=intents[0];
   if(intents.length!==1||!intent||intent.requester_person_id!==userId||intent.kind!=='gl'||intent.mode!=='post_journal')throw new Error('Saved historical GL import unavailable');
   const source=await readHistoricalImportSource(ctx,intent.source_id);
   if(source.artifact?.extractor.id!=='gl_csv')throw new Error('Legacy GL requires saved original CSV evidence');
   const key=source.artifact.extraction.groupKey,group=groups.get(key);
   if(!group||seen.has(key))throw new Error('Legacy GL groups differ from saved source');
   assertLegacyGlRowsMatch(group,source.normalized,key);seen.add(key);
   total=total.add(source.normalized.amount);lineCount+=source.normalized.records.length;
  }
  // Keep the old numeric response honest without using it in a financial write.
  const totalValue=Number(total.toFixed());
  if(total.mul(100).gt(Number.MAX_SAFE_INTEGER)||!new D(String(totalValue)).eq(total))throw new Error('Legacy GL response exceeds exact numeric bound; use the historical import result');
  for(const binding of bindings.imports)await executeHistoricalImport(ctx,{entityType:'historical_import',entityId:binding.importId,operation:'historical_import.post'},binding.approvalId);
  return{entriesCreated:bindings.imports.length,linesCreated:lineCount,totalValue};
 });
}
