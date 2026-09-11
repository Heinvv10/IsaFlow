import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import type {PoolClient} from 'pg';
import {authorityLockFixture,type Timed} from './authorityLockFixture';
import {ensureOpenPeriod} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
/**
 * Opt-in measurement, not a gate: how long ordinary same-company requests hold the company authority key, from their
 * first permission check to COMMIT, sampled from pg_locks per transaction. Set ISAFLOW_MEASURE_AUTHORITY_HOLD to a JSON
 * output path to run it. Holds are lower bounds (first to last sighting; the sampler polls continuously, ~1 ms).
 */
const out=process.env.ISAFLOW_MEASURE_AUTHORITY_HOLD;
let x:Awaited<ReturnType<typeof authorityLockFixture>>,sampler:PoolClient,key:string;
const invoices:string[]=[];let period='';
beforeAll(async()=>{
 if(!out)return;
 x=await authorityLockFixture();sampler=await x.pool.connect();
 key=(await sampler.query("SELECT hashtextextended('control-authority:'||$1::text,0)::text AS key",[x.f.companyA])).rows[0].key;
 const company=x.f.companyA,accounts:Record<string,string>={};
 period=await ensureOpenPeriod(x.pool,company,'2026-09-15','Synthetic hold measurement');
 for(const [subtype,type,side] of [['receivable','asset','debit'],['default_revenue','revenue','credit'],['vat_output','liability','credit'],['bank','asset','debit']] as const){
  const id=randomUUID();accounts[subtype]=id;
  await x.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,$6,true,true,3)",[id,company,id.slice(0,12),subtype,type,side]);
 }
 // 5 000 posted journals, 10 000 lines, across September: enough for the reports to do real work.
 await x.pool.query(`WITH e AS (INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,posted_by,posted_at)
  SELECT gen_random_uuid(),$1,'M'||g,DATE '2026-09-01'+(g%29),'posted','auto_migration',$2,$2,now() FROM generate_series(1,5000) g RETURNING id)
  INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,company_id)
  SELECT id,$3::uuid,100,0,$1::uuid FROM e UNION ALL SELECT id,$4::uuid,0,100,$1::uuid FROM e`,[company,x.f.u1.id,accounts.bank,accounts.default_revenue]);
 const customer=randomUUID();
 await x.pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,company,'Synthetic hold customer']);
 for(let i=0;i<100;i++){
  const id=randomUUID();invoices.push(id);
  await x.pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
   VALUES($1,$2,$3,$3,$4,'2026-09-15',100,15,115,'ZAR',1,115,$5)`,[id,company,customer,id.slice(0,20),x.f.u1.id]);
  await x.pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic hold service',1,100,100,15)",[id]);
 }
},120000);
afterAll(async()=>{if(!out)return;sampler?.release();if(x)await x.close();});

async function holds<T>(run:()=>Promise<T>):Promise<{holds:number[];value:T}>{
 const seen=new Map<string,{first:number;last:number}>();let stop=false;
 const loop=(async()=>{while(!stop){const t=performance.now();
  const rows=(await sampler.query(`SELECT virtualtransaction FROM pg_locks WHERE locktype='advisory' AND granted AND mode='ExclusiveLock'
   AND objsubid=1 AND ((classid::bigint<<32)|objid::bigint)=$1::bigint`,[key])).rows as {virtualtransaction:string}[];
  for(const row of rows){const span=seen.get(row.virtualtransaction);if(span)span.last=t;else seen.set(row.virtualtransaction,{first:t,last:t});}
 }})();
 try{const value=await run();return{holds:[...seen.values()].map(s=>Math.round(s.last-s.first)),value};}finally{stop=true;await loop;}
}
const pct=(v:number[],p:number)=>{const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))]??null;};
const summary=(v:number[])=>({n:v.length,p50:pct(v,0.5),p95:pct(v,0.95),max:v.length?Math.max(...v):null});
const okBody=(row:Timed)=>row.status===200&&!JSON.stringify(row.body).includes('"isError":true');

it.skipIf(!out)('measures how long same-company requests hold the company authority key',async()=>{
 const paths:Record<string,()=>Promise<Timed>>={
  'REST list read (control-approvals GET)':()=>x.rest('GET','/api/accounting/control-approvals',{}),
  'REST controlled write (audit-check-runs POST)':()=>x.rest('POST','/api/accounting/audit-check-runs',{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}),
  'MCP list read (list_journals)':()=>x.mcp('list_journals',{from_date:'2026-09-01',to_date:'2026-09-30'}),
  'MCP report (trial_balance)':()=>x.mcp('trial_balance',{fiscal_period_id:period}),
  'MCP report (general_ledger, September)':()=>x.mcp('general_ledger',{period_start:'2026-09-01',period_end:'2026-09-30'}),
  'MCP report (data_integrity_checks)':()=>x.mcp('data_integrity_checks',{}),
 };
 const result:Record<string,unknown>={};
 for(const [label,run] of Object.entries(paths)){
  const heldMs:number[]=[],latency:number[]=[];let failures=0;
  // The check-run enqueue is capped at 6 active per company, so it runs 6 times.
  for(let i=0;i<(label.startsWith('MCP')?8:label.includes('audit-check-runs')?6:15);i++){
   const {holds:h,value}=await holds(run);heldMs.push(...h);latency.push(value.ms);if(!okBody(value))failures++;
   if(!okBody(value)&&failures===1)result[`${label} first failure`]=JSON.stringify(value.body).slice(0,300);
  }
  result[label]={holdMs:summary(heldMs),requestMs:summary(latency),failures};
 }
 const heldMs:number[]=[],latency:number[]=[];let failures=0;
 for(let i=0;i<5;i++){
  const {holds:h,value}=await holds(()=>x.mcp('bulk_finalize_invoices',{invoice_ids:invoices.slice(i*10,i*10+10),idempotency_key:randomUUID()}));
  heldMs.push(...h);latency.push(value.ms);if(!okBody(value)){failures++;result['bulk first failure']??=JSON.stringify(value.body).slice(0,300);}
 }
 result['MCP bulk write (bulk_finalize_invoices, 10 invoices)']={holdMs:summary(heldMs),requestMs:summary(latency),failures};
 // One 50-invoice batch, with another person's ordinary read issued while it runs.
 const big=holds(()=>x.mcp('bulk_finalize_invoices',{invoice_ids:invoices.slice(50,100),idempotency_key:randomUUID()},'u1'));
 await new Promise(r=>setTimeout(r,300));
 const during=await x.rest('GET','/api/accounting/control-approvals',{},'u2');
 const bigResult=await big;
 result['MCP bulk write (bulk_finalize_invoices, 50 invoices)']={holdMs:bigResult.holds,requestMs:bigResult.value.ms,ok:okBody(bigResult.value),
  body:okBody(bigResult.value)?undefined:JSON.stringify(bigResult.value.body).slice(0,300)};
 result['another person\'s read during the 50-invoice batch']={status:during.status,ms:during.ms,retryAfter:during.retryAfter};
 const posted=(await x.pool.query("SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1 AND id=ANY($2::uuid[]) AND gl_journal_entry_id IS NOT NULL",[x.f.companyA,invoices])).rows[0].n;
 result['bulk invoices posted']=posted;
 // What a second request sees behind a first transaction holding the key for 3 s and 8 s.
 const behind:Record<string,unknown>={};
 for(const [who,second] of [['same person','u1'],['another person','u2']] as const)for(const holdMs of [3000,8000]){
  let checked!:()=>void;const ready=new Promise<void>(r=>{checked=r;});
  const first=withAuditWorkerTransaction(x.pool,{companyId:x.f.companyA,personId:x.f.u1.id,jobId:randomUUID()},'read committed',Date.now()+20000,undefined,
   store=>withControlRequest(store,{companyId:x.f.companyA,personId:x.f.u1.id,authMethod:'cookie'},async()=>{
    const {resolveEffectivePermissions}=await import('@/lib/auth/effectivePermissions');
    await resolveEffectivePermissions(requireControlTx());checked();await new Promise(r=>setTimeout(r,holdMs));
   }));
  await ready;const row=await x.rest('GET','/api/accounting/control-approvals',{},second);await first;
  behind[`${who}, first holds ${holdMs} ms`]={status:row.status,ms:row.ms,retryAfter:row.retryAfter};
 }
 result['second request behind a holder']=behind;
 writeFileSync(out!,JSON.stringify(result,null,1));
 expect(Object.keys(result).length).toBeGreaterThan(0);
},600000);
