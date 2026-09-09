import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
import type {AuditSnapshotData} from '@/modules/accounting/services/controls/auditSnapshotSeal';
export interface ScaleCensus{headerCount:number;lineCount:number;debit:string;credit:string;identityHash:string}
function cents(value:unknown):bigint{
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))throw new Error('Invalid scale decimal');
 const [whole,fraction='']=value.split('.');return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
}
function money(value:bigint){return `${value/100n}.${String(value%100n).padStart(2,'0')}`;}
function identities(rows:Array<{source:string;id:string}>){
 const hash=createHash('sha256');for(const row of [...rows].sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:a.id<b.id?-1:a.id>b.id?1:0))hash.update(`${row.source}:${row.id}\n`);
 return hash.digest('hex');
}
/** Independent verifier over authenticated retained facts, not the production totals reducer. */
export function scaleCensus(records:AuditSnapshotData['records']):ScaleCensus{
 let headerCount=0,lineCount=0,debit=0n,credit=0n;const ids=new Set<string>();
 for(const row of records){
  const key=`${row.source}:${row.id}`;if(ids.has(key))throw new Error('Duplicate retained identity');ids.add(key);
  if(row.source==='journal_entry')headerCount++;
  else if(row.source==='journal_line'){lineCount++;debit+=cents(row.data.debit);credit+=cents(row.data.credit);}
  else throw new Error('Unexpected scale source');
 }
 return{headerCount,lineCount,debit:money(debit),credit:money(credit),identityHash:identities(records)};
}
/** Fresh fixture tenant, bounded batches and independent SQL census. No production posting claim. */
export async function seedAuditScale(pool:Pool,fixture:ForensicFixture,recordCount:number):Promise<ScaleCensus>{
 if(![1000,100000].includes(recordCount))throw new Error('Unsupported scale fixture population');
 const debit=randomUUID(),credit=randomUUID();
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$3,left($1::uuid::text,20),'Scale debit','asset','debit',3),($2,$3,left($2::uuid::text,20),'Scale credit','liability','credit',3)",[debit,credit,fixture.companyA]);
 for(let offset=0;offset<recordCount/4;offset+=250){
  const ids=Array.from({length:Math.min(250,recordCount/4-offset)},()=>randomUUID());
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by) SELECT id,$2,'2026-09-09',id::text,'manual','draft',$3 FROM unnest($1::uuid[]) id",[ids,fixture.companyA,fixture.u1.id]);
  await pool.query("INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) SELECT id,$2,CASE WHEN n<3 THEN $3::uuid ELSE $4::uuid END,CASE WHEN n<3 THEN n ELSE 0 END,CASE WHEN n=3 THEN 3 ELSE 0 END FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,3) n",[ids,fixture.companyA,debit,credit]);
 }
 const header=(await pool.query("SELECT COUNT(*)::int AS count FROM gl_journal_entries WHERE company_id=$1 AND entry_date<='2026-09-09'",[fixture.companyA])).rows[0] as {count:number};
 const line=(await pool.query("SELECT COUNT(*)::int AS count,SUM(l.debit)::text AS debit,SUM(l.credit)::text AS credit FROM gl_journal_lines l JOIN gl_journal_entries h ON h.company_id=l.company_id AND h.id=l.journal_entry_id WHERE l.company_id=$1 AND h.entry_date<='2026-09-09'",[fixture.companyA])).rows[0] as {count:number;debit:string;credit:string};
 const rows=(await pool.query("SELECT 'journal_entry' AS source,id::text FROM gl_journal_entries WHERE company_id=$1 AND entry_date<='2026-09-09' UNION ALL SELECT 'journal_line',l.id::text FROM gl_journal_lines l JOIN gl_journal_entries h ON h.company_id=l.company_id AND h.id=l.journal_entry_id WHERE l.company_id=$1 AND h.entry_date<='2026-09-09'",[fixture.companyA])).rows as Array<{source:string;id:string}>;
 return{headerCount:header.count,lineCount:line.count,debit:money(cents(line.debit)),credit:money(cents(line.credit)),identityHash:identities(rows)};
}
