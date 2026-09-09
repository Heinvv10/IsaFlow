import {createHash} from 'node:crypto';
import {canonicalJson} from './canonical';
import {normalizeHistoricalImport} from './historicalImportExactPlan';
import {historicalCsvRows} from './historicalImportCsvRows';
import type {HistoricalImportNormalized,HistoricalImportSystem} from './historicalImportTypes';
const required=['date','accountCode','debit','credit','description'] as const;
const allowed=[...required,'reference','recordId','vatCode','costCentre'] as const;
type Field=typeof allowed[number];
export interface HistoricalCsvExtraction {
 sourceKey:string;sourceSystem:HistoricalImportSystem;kind:'gl'|'opening_balance';delimiter?:','|';';columnMap?:Partial<Record<Field,string>>;
}
export interface HistoricalArtifactGroup {groupKey:string;sourceRecordIds:string[];normalized:HistoricalImportNormalized|null;error?:string}
export interface HistoricalArtifactGroups {recordCount:number;invalidGroupCount:number;groups:HistoricalArtifactGroup[]}
/** Original GL CSV, with frozen explicit source-column mapping; never accepts converted rows. */
export function extractHistoricalCsvGroups(bytes:Buffer,options:HistoricalCsvExtraction):HistoricalArtifactGroups{
 if(!options||Object.keys(options).some(key=>!['sourceKey','sourceSystem','kind','delimiter','columnMap'].includes(key))||!['gl','opening_balance'].includes(options.kind)||!options.sourceKey?.trim()||options.sourceKey.length>300)throw new Error('Invalid historical CSV extraction identity');
 if(options.delimiter!==undefined&&![';',','].includes(options.delimiter))throw new Error('Unsupported historical CSV delimiter');
 const [rawHeader,...rows]=historicalCsvRows(bytes,options.delimiter??',');
 const header=rawHeader?.map(cell=>cell.trim());
 if(!header||!rows.length||header.some(key=>!key)||new Set(header).size!==header.length)throw new Error('Invalid historical CSV header');
 const mapping=options.columnMap??Object.fromEntries(header.map(key=>[key,key]));
 if(Object.keys(mapping).some(key=>!allowed.includes(key as Field)))throw new Error('Unknown historical CSV column mapping');
 const names=Object.values(mapping);
 if(names.some(name=>typeof name!=='string'||!header.includes(name))||new Set(names).size!==names.length||required.some(field=>!mapping[field]))throw new Error('Incomplete historical CSV column mapping');
 if(header.some(name=>!names.includes(name)))throw new Error('Historical CSV contains unmapped source columns');
 const groups=new Map<string,Array<Record<string,string>>>(),ids=new Set<string>();
 rows.forEach((values,index)=>{
  if(values.length!==header.length)throw new Error('Historical CSV column count differs');
  const source=Object.fromEntries(header.map((key,i)=>[key,values[i]!]));
  const row=Object.fromEntries(Object.entries(mapping).map(([field,column])=>[field,source[column!]!]));
  if(row.costCentre?.trim())throw new Error('Historical CSV accounting dimension requires a supported exact extractor');
  const recordId=row.recordId?.trim()||`row:${index+2}`;
  if(ids.has(recordId))throw new Error('Duplicate historical source record identity');ids.add(recordId);
  const key=canonicalJson([row.date,row.reference??'']);
  const group=groups.get(key)??[];group.push({...row,recordId});groups.set(key,group);
  if(groups.size>100)throw new Error('Historical synchronous group bound exceeded');
  if(group.length>1000)throw new Error('Historical group record bound exceeded');
 });
 const extracted=[...groups.entries()].sort(([a],[b])=>a<b?-1:1).map(([groupKey,group]):HistoricalArtifactGroup=>{
  const sourceRecordIds=group.map(row=>row.recordId!).sort();
  const suffix=createHash('sha256').update(groupKey).digest('hex');
  try{
   const normalized=normalizeHistoricalImport({version:1,sourceSystem:options.sourceSystem,sourceKey:`${options.sourceKey}:${options.kind}:${suffix}`,kind:options.kind,mode:'post_journal',
    accountingDate:group[0]!.date,currency:'ZAR',records:group.map(row=>({recordId:row.recordId,accountCode:row.accountCode,debit:row.debit,credit:row.credit,description:row.description,...(row.vatCode?{vatType:row.vatCode}:{})}))});
   return{groupKey,sourceRecordIds,normalized};
  }catch(error){return{groupKey,sourceRecordIds,normalized:null,error:error instanceof Error?error.message:'Historical group is invalid'};}
 });
 return{recordCount:rows.length,invalidGroupCount:extracted.filter(group=>group.normalized===null).length,groups:extracted};
}
