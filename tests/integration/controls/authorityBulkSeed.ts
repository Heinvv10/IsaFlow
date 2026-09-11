import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {PoolClient} from 'pg';
import type {authorityLockFixture,Timed} from './authorityLockFixture';
import {ensureOpenPeriod,ensureOpenPeriodForToday} from '../forensic-fixture';
import {seedApAccounts} from './apSyntheticAccounts';
type Fixture=Awaited<ReturnType<typeof authorityLockFixture>>;
/** Company A's charts, parties and bank account for driving the bulk paths, plus makers of fresh elements for each. */
export async function seedBulkPaths(x:Fixture){
 const company=x.f.companyA,seeded={customer:randomUUID(),supplier:randomUUID(),bank:randomUUID(),contra:randomUUID(),expense:''};
 await ensureOpenPeriod(x.pool,company,'2026-09-15','Synthetic bulk measurement');await ensureOpenPeriodForToday(x.pool,company,'Synthetic bulk today');
 seeded.expense=(await seedApAccounts(x.pool,company)).default_expense;
 for(const [subtype,type,side] of [['receivable','asset','debit'],['default_revenue','revenue','credit'],['vat_output','liability','credit']] as const){
  const id=randomUUID();
  await x.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,$6,true,true,3)",[id,company,id.slice(0,12),subtype,type,side]);
 }
 await x.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bulk bank','asset','bank','debit',3,true)",[seeded.bank,company]);
 await x.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bulk expense','expense','other','debit',3,true)",[seeded.contra,company]);
 await x.pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic bulk bank',$2,'ZAR')",[company,seeded.bank]);
 await x.pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[seeded.customer,company,'Synthetic bulk customer']);
 await x.pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic bulk supplier')",[seeded.supplier,company]);
 const many=async(n:number,insert:(id:string)=>Promise<unknown>)=>{const ids:string[]=[];for(let i=0;i<n;i++){const id=randomUUID();ids.push(id);await insert(id);}return ids;};
 return{seeded,
  customerInvoices:(n:number)=>many(n,async id=>{
   await x.pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
    VALUES($1,$2,$3,$3,$4,'2026-09-15',100,15,115,'ZAR',1,115,$5)`,[id,company,seeded.customer,id.slice(0,20),x.f.u1.id]);
   await x.pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic bulk service',1,100,100,15)",[id]);}),
  supplierInvoices:(n:number)=>many(n,async id=>{
   await x.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by) VALUES($1,$2,$3,$4,'2026-09-15',100,0,100,0,'pending_approval',$5)",[id,company,seeded.supplier,id.slice(0,20),x.f.u1.id]);
   await x.pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_amount) VALUES($1,'Synthetic bulk line',1,100,100,0)",[id]);}),
  creditNotes:(n:number)=>many(n,id=>x.pool.query("INSERT INTO credit_notes(id,company_id,client_id,credit_note_number,credit_date,type,status,subtotal,tax_amount,total_amount,currency,currency_code,created_by) VALUES($1,$2,$3,$4,'2026-09-15','customer','draft',100,15,115,'ZAR','ZAR',$5)",[id,company,seeded.customer,id.slice(0,20),x.f.u1.id])),
  bankLines:(n:number,date='2026-09-15')=>many(n,id=>x.pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,$4,-100,$5,'imported')",[id,company,seeded.bank,date,`Synthetic bulk line ${id.slice(0,8)}`])),
  allocations:(ids:readonly string[])=>ids.map(id=>({transaction_id:id,contra_account_id:seeded.contra})),
 };
}
/** The longest hold of the company authority key by any transaction while run executes, sampled from pg_locks. */
export async function heldWhile(x:Fixture,sampler:PoolClient,run:()=>Promise<Timed>):Promise<{holdMs:number;row:Timed}>{
 const key=(await sampler.query("SELECT hashtextextended('control-authority:'||$1::text,0)::text AS key",[x.f.companyA])).rows[0].key as string;
 const seen=new Map<string,{first:number;last:number}>();let stop=false;
 const loop=(async()=>{while(!stop){const t=performance.now();
  const rows=(await sampler.query(`SELECT virtualtransaction FROM pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock'
   AND objsubid=1 AND ((classid::bigint<<32)|objid::bigint)=$1::bigint`,[key])).rows as {virtualtransaction:string}[];
  for(const row of rows){const span=seen.get(row.virtualtransaction);if(span)span.last=t;else seen.set(row.virtualtransaction,{first:t,last:t});}
 }})();
 try{const row=await run();return{holdMs:Math.max(0,...[...seen.values()].map(s=>Math.round(s.last-s.first))),row};}finally{stop=true;await loop;}
}
export const refused=(row:Timed)=>row.status!==200||JSON.stringify(row.body).includes('"isError":true');
/** The text of an MCP tool reply. */
export const toolText=(row:Timed)=>((row.body as {result?:{content?:Array<{text:string}>}}).result?.content??[]).map(c=>c.text).join('\n');
