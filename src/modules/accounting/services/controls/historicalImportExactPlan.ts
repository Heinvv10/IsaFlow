import Decimal from 'decimal.js';
import {parseHistoricalImportCsv} from './historicalImportCsv';
import {isRealCalendarDate,UUID_RE} from '@/lib/validation';
import {canonicalJson,canonicalMoney} from './canonical';
import type {HistoricalImportDocument,HistoricalImportNormalized,HistoricalImportRecord,HistoricalImportSource} from './historicalImportTypes';
const D=Decimal.clone({precision:80});
export const HISTORICAL_SOURCE_MAX_BYTES=5242880;
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Invalid historical source fields');
 return value as Record<string,unknown>;
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))throw new Error('Invalid historical source text');
 return value.trim();
}
export function importMoney(value:unknown):string{
 if(typeof value!=='string')throw new Error('Historical money must be decimal text');
 const amount=new D(canonicalMoney(value));
 if(amount.lt(0)||amount.gte('100000000000000000000')||!amount.mul(100).isInteger())throw new Error('Historical money exceeds exact cent bound');
 return canonicalMoney(amount.toFixed());
}
function document(value:unknown):HistoricalImportDocument{
 const d=object(value,['partyId','invoiceNumber','dueDate','subtotal','taxAmount','totalAmount','amountPaid','settlements']);
 if(typeof d.partyId!=='string'||!UUID_RE.test(d.partyId)||typeof d.dueDate!=='string'||!isRealCalendarDate(d.dueDate))throw new Error('Invalid historical document identity or date');
 const subtotal=importMoney(d.subtotal),taxAmount=importMoney(d.taxAmount),totalAmount=importMoney(d.totalAmount),amountPaid=importMoney(d.amountPaid);
 if(!new D(subtotal).add(taxAmount).eq(totalAmount)||!new D(totalAmount).gt(0)||new D(amountPaid).gt(totalAmount))throw new Error('Historical document does not balance');
 if(!Array.isArray(d.settlements)||d.settlements.length>100)throw new Error('Historical settlement bound exceeded');
 const settlements=d.settlements.map(value=>{
  const row=object(value,['journalId','amount']);
  if(typeof row.journalId!=='string'||!UUID_RE.test(row.journalId))throw new Error('Invalid historical settlement journal');
  const amount=importMoney(row.amount);if(!new D(amount).gt(0))throw new Error('Invalid historical settlement amount');
  return {journalId:row.journalId.toLowerCase(),amount};
 }).sort((a,b)=>a.journalId<b.journalId?-1:1);
 if(new Set(settlements.map(s=>s.journalId)).size!==settlements.length||!settlements.reduce((sum,s)=>sum.add(s.amount),new D(0)).eq(amountPaid))throw new Error('Historical paid amount requires exact settlement evidence');
 return {partyId:d.partyId.toLowerCase(),invoiceNumber:text(d.invoiceNumber,100),dueDate:d.dueDate,subtotal,taxAmount,totalAmount,amountPaid,settlements};
}
/** The authoritative normalized source is derived from artifact contents, never a parallel caller object. */
export function normalizeHistoricalImport(value:unknown):HistoricalImportNormalized{
 canonicalJson(value);
 const source=object(value,['version','sourceSystem','sourceKey','kind','mode','accountingDate','currency','records','document','existingJournalId']);
 if(source.version!==1||!['sage','xero','quickbooks','pastel','csv'].includes(String(source.sourceSystem))||!['gl','opening_balance','customer_invoice','supplier_invoice'].includes(String(source.kind))||!['post_journal','attach_subledger'].includes(String(source.mode)))throw new Error('Invalid historical import kind or mode');
 if(source.currency!=='ZAR')throw new Error('Unsupported historical source currency');
 if(typeof source.accountingDate!=='string'||!isRealCalendarDate(source.accountingDate))throw new Error('Invalid historical accounting date');
 if(!Array.isArray(source.records)||source.records.length<2||source.records.length>1000)throw new Error('Historical record population bound exceeded');
 const records:HistoricalImportRecord[]=source.records.map(value=>{
  const row=object(value,['recordId','accountCode','debit','credit','description','vatType']);
  const debit=importMoney(row.debit),credit=importMoney(row.credit);
  if((debit==='0')===(credit==='0'))throw new Error('Invalid historical debit/credit');
  if(row.vatType!==undefined&&!['standard','zero_rated','exempt','no_vat','capital_goods','import','export','none'].includes(String(row.vatType)))throw new Error('Invalid historical VAT classification');
  return{recordId:text(row.recordId,200),accountCode:text(row.accountCode,20),debit,credit,description:text(row.description,1000),...(row.vatType===undefined?{}:{vatType:String(row.vatType)})};
 }).sort((a,b)=>a.recordId<b.recordId?-1:1);
 if(new Set(records.map(r=>r.recordId)).size!==records.length)throw new Error('Duplicate historical record identity');
 const debit=records.reduce((sum,r)=>sum.add(r.debit),new D(0)),credit=records.reduce((sum,r)=>sum.add(r.credit),new D(0));
 if(!debit.eq(credit)||!debit.gt(0))throw new Error('Historical source does not balance');
 const kind=source.kind as HistoricalImportSource['kind'],mode=source.mode as HistoricalImportSource['mode'];
 const invoice=kind==='customer_invoice'||kind==='supplier_invoice';
 if(invoice!==Boolean(source.document))throw new Error('Historical document is required only for invoice groups');
 const doc=invoice?document(source.document):undefined;
 if(doc&&!new D(doc.totalAmount).eq(debit))throw new Error('Historical document and ledger amounts differ');
 if(mode==='attach_subledger'&&(!invoice||typeof source.existingJournalId!=='string'||!UUID_RE.test(source.existingJournalId)))throw new Error('Historical attachment requires an owned journal identity');
 if(mode==='post_journal'&&source.existingJournalId!==undefined)throw new Error('New historical posting cannot claim an existing journal');
 return{version:1,sourceSystem:source.sourceSystem as HistoricalImportSource['sourceSystem'],sourceKey:text(source.sourceKey,500),kind,mode,
  accountingDate:source.accountingDate,currency:'ZAR',records,amount:importMoney(debit.toFixed()),...(doc?{document:doc}:{}),
  ...(mode==='attach_subledger'?{existingJournalId:String(source.existingJournalId).toLowerCase()}: {})};
}
export function parseHistoricalImportArtifact(bytes:Buffer,mimeType:string):HistoricalImportNormalized{
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>HISTORICAL_SOURCE_MAX_BYTES)throw new Error('Historical artifact byte bound exceeded');
 if(!['application/json','text/csv'].includes(mimeType))throw new Error('Historical artifact requires a supported source extractor');
 const textValue=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(mimeType==='text/csv')return normalizeHistoricalImport(parseHistoricalImportCsv(textValue));
 let parsed:unknown;try{parsed=JSON.parse(textValue);}catch{throw new Error('Historical artifact is not valid JSON');}
 return normalizeHistoricalImport(parsed);
}
