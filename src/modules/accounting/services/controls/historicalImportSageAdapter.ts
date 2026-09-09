import {UUID_RE} from '@/lib/validation';
import {HISTORICAL_SOURCE_MAX_BYTES,importMoney} from './historicalImportExactPlan';
import {extractHistoricalCsvGroups} from './historicalImportCsvAdapter';
import {canonicalJson} from './canonical';
export interface HistoricalSageRow {id:string;sageId:string|null;accountCode:string;accountingDate:string;description:string|null;debit:string;credit:string;reference:string|null;migrationStatus:string;journalEntryId:string|null}
export interface HistoricalSageMapping {id:string;sourceAccountCode:string;glAccountId:string;glAccountCode:string}
export interface HistoricalSageSnapshot {version:1;table:'sage_ledger_transactions';companyId:string;rows:HistoricalSageRow[];mappings:HistoricalSageMapping[]}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!(key in value)))throw new Error('Invalid persisted Sage source fields');
 return value as Record<string,unknown>;
}
function string(value:unknown,max=1000):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('Invalid persisted Sage source text');return value;}
function nullable(value:unknown):value is string|null{return value===null||typeof value==='string';}
export function readHistoricalSageSnapshot(bytes:Buffer,companyId:string):HistoricalSageSnapshot{
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>HISTORICAL_SOURCE_MAX_BYTES)throw new Error('Historical artifact byte bound exceeded');
 let decoded:unknown;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Invalid persisted Sage UTF-8 JSON');}
 canonicalJson(decoded);
 const value=object(decoded,['version','table','companyId','rows','mappings']);
 if(value.version!==1||value.table!=='sage_ledger_transactions')throw new Error('Unsupported persisted Sage source extractor');
 if(value.companyId!==companyId||!UUID_RE.test(companyId))throw new Error('Persisted Sage source tenant differs');
 if(!Array.isArray(value.rows)||!value.rows.length||value.rows.length>100000||!Array.isArray(value.mappings)||value.mappings.length>100000)throw new Error('Persisted Sage source record bound exceeded');
 const rows=value.rows.map(value=>{
  const row=object(value,['id','sageId','accountCode','accountingDate','description','debit','credit','reference','migrationStatus','journalEntryId']);
  if(typeof row.id!=='string'||!UUID_RE.test(row.id)||!nullable(row.sageId)||!nullable(row.description)||!nullable(row.reference))throw new Error('Invalid persisted Sage record identity');
  if(row.journalEntryId!==null||!['pending','failed'].includes(String(row.migrationStatus)))throw new Error('Persisted Sage record is already imported or linked');
  importMoney(row.debit);importMoney(row.credit);
  string(row.accountCode,100);string(row.accountingDate,10);
  return row as unknown as HistoricalSageRow;
 });
 if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('Duplicate persisted Sage record identity');
 const mappings=value.mappings.map(value=>{
  const mapping=object(value,['id','sourceAccountCode','glAccountId','glAccountCode']);
  if(typeof mapping.id!=='string'||!UUID_RE.test(mapping.id)||typeof mapping.glAccountId!=='string'||!UUID_RE.test(mapping.glAccountId))throw new Error('Invalid persisted Sage account mapping identity');
  string(mapping.sourceAccountCode,100);string(mapping.glAccountCode,20);return mapping as unknown as HistoricalSageMapping;
 });
 if(new Set(mappings.map(mapping=>mapping.sourceAccountCode)).size!==mappings.length||new Set(mappings.map(mapping=>mapping.id)).size!==mappings.length)throw new Error('Ambiguous persisted Sage account mapping');
 return{version:1,table:'sage_ledger_transactions',companyId,rows,mappings};
}
/** Snapshot JSON contains SQL decimal text. It is persisted-column evidence, never original HTTP bytes. */
export function extractHistoricalSageGroups(bytes:Buffer,options:{sourceKey:string;companyId:string}){
 if(!options||options.sourceKey!=='sage-ledger'||Object.keys(options).some(key=>!['sourceKey','companyId'].includes(key)))throw new Error('Persisted Sage economic identity is server owned');
 const snapshot=readHistoricalSageSnapshot(bytes,options.companyId),mapping=new Map(snapshot.mappings.map(mapping=>[mapping.sourceAccountCode,mapping.glAccountCode]));
 const unmapped=new Set(snapshot.rows.filter(row=>!mapping.has(row.accountCode)).map(row=>row.id));
 const cell=(value:string)=>`"${value.replaceAll('"','""')}"`;
 const csv=['date,reference,accountCode,debit,credit,description,recordId',...snapshot.rows.map(row=>[
  row.accountingDate,canonicalJson([row.reference]),mapping.get(row.accountCode)??'',row.debit,row.credit,row.description?.trim()?row.description:`Sage ledger row ${row.id}`,row.id].map(cell).join(','))].join('\n');
 const result=extractHistoricalCsvGroups(Buffer.from(csv),{sourceKey:options.sourceKey,sourceSystem:'sage',kind:'gl'});
 for(const group of result.groups)if(group.sourceRecordIds.some(id=>unmapped.has(id))){group.normalized=null;group.error='Historical source account is unmapped';}
 return{...result,invalidGroupCount:result.groups.filter(group=>group.normalized===null).length};
}
