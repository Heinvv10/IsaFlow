const cp=require('node:child_process');
const vm=require('node:vm');
const ts=require('typescript');
const {Client}=require('pg');
const fs=require('node:fs');
const SHA='5661d6f0f5f2212705151e95455a3f681ddf840e';
const source=p=>cp.execFileSync('git',['show',SHA+':'+p],{encoding:'utf8'});
function load(p,mocks={},extra={}){const m={exports:{}};vm.runInNewContext(ts.transpileModule(source(p),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,require:n=>n in mocks?mocks[n]:require(n),...extra});return m.exports;}
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
(async()=>{
 const port=cp.execFileSync('docker',['port','isaflow-code-audit-20260908','5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();
 const db=new Client({host:'127.0.0.1',port:Number(port),user:'postgres',database:'isaflow_test'});await db.connect();
 const results={sha:SHA,scope:'Synthetic fixture database only; real PostgreSQL executes committed service SQL and selected exact migrations.'};
 try{
 await db.query('CREATE SCHEMA audit_transfer');await db.query('SET search_path TO audit_transfer, public');
 await db.query(`CREATE TABLE gl_journal_entries(id uuid PRIMARY KEY,company_id uuid);CREATE TABLE gl_journal_lines(id uuid PRIMARY KEY,journal_entry_id uuid,gl_account_id uuid);CREATE TABLE bank_transactions(id uuid PRIMARY KEY,company_id uuid,bank_account_id uuid,transaction_date date,amount numeric,status text,matched_journal_line_id uuid,allocated_entity_name text,allocation_type text,counterparty_account_id uuid,allocation_rule_id uuid,allocation_rule_name text,updated_at timestamp);`);
 await db.query('INSERT INTO gl_journal_entries VALUES($1,$2)',[id(10),id(1)]);
 await db.query('INSERT INTO gl_journal_lines VALUES($1,$2,$3),($4,$2,$5)',[id(11),id(10),id(2),id(12),id(3)]);
 await db.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,status,matched_journal_line_id) VALUES($1,$2,$3,'2026-09-01',-1000,'allocated',$4),($5,$2,$6,'2026-09-01',1000,'imported',NULL),($7,$2,$6,'2026-09-02',1000,'imported',NULL)",[id(20),id(1),id(2),id(11),id(21),id(3),id(22)]);
 const sql=async(s,...v)=>(await db.query(s.reduce((a,x,i)=>a+x+(i<v.length?'$'+(i+1):''),''),v)).rows;
 const logging={log:{info(){},warn(){},error(){}}};
 const bank=load('src/modules/accounting/services/bank/bankTransferLinkService.ts',{'@/lib/neon':{sql},'@/lib/logger':logging});
 const count=await bank.relinkTransferCounterparts(id(1),id(3));
 const linked=(await db.query("SELECT id,status,matched_journal_line_id FROM bank_transactions WHERE bank_account_id=$1 ORDER BY id",[id(3)])).rows;
 results.F08={count,linked,confirmed:count===2&&linked[0].matched_journal_line_id===linked[1].matched_journal_line_id};
 await db.query('CREATE SCHEMA audit_rates');await db.query('SET search_path TO audit_rates, public');
 await db.query('CREATE TABLE practice_clients(id uuid PRIMARY KEY)');
 await db.query(source('scripts/migrations/sql/372_practice_staff_rates.sql'));
 await db.query(source('scripts/migrations/sql/395_practice_client_rate_overrides.sql'));
 await db.query('INSERT INTO practice_clients VALUES($1)',[id(30)]);
 let failedInsert;
 try{await db.query("INSERT INTO practice_client_rate_overrides(company_id,client_id,staff_user_id,rate_per_hour,effective_from) VALUES($1,$2,$3,200,'2026-01-01')",[id(1),id(30),id(31)]);}catch(e){failedInsert={code:e.code,column:e.column};}
 await db.query("INSERT INTO practice_client_rate_overrides(company_id,client_id,user_id,rate,staff_user_id,rate_per_hour,effective_from) VALUES($1,$2,$3,100,$3,100,'2026-01-01')",[id(1),id(30),id(31)]);
 await db.query('UPDATE practice_client_rate_overrides SET rate_per_hour=200');
 const rates=(await db.query('SELECT rate,rate_per_hour FROM practice_client_rate_overrides')).rows;
 results.F11={failedInsert,rates,confirmed:failedInsert?.code==='23502'&&rates[0].rate==='100.00'&&rates[0].rate_per_hour==='200.00'};
 await db.query('CREATE ROLE audit_reader');await db.query('GRANT USAGE ON SCHEMA audit_rates TO audit_reader');await db.query('GRANT SELECT ON audit_rates.practice_client_rate_overrides TO audit_reader');
 await db.query('SET ROLE audit_reader');
 await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('app.current_company_id',$2,false)",[JSON.stringify({sub:id(31),role:'authenticated'}),id(1)]);
 const cookieVisible=(await db.query('SELECT COUNT(*)::int AS n FROM practice_client_rate_overrides')).rows[0].n;
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id(31),role:'authenticated',company_id:id(1)})]);
 const bearerVisible=(await db.query('SELECT COUNT(*)::int AS n FROM practice_client_rate_overrides')).rows[0].n;
 await db.query('RESET ROLE');
 results.practiceRls={cookieVisible,bearerVisible,confirmed:cookieVisible===0&&bearerVisible===1};
 const inputs={id:'test',principal:1200,startDate:'2026-01-01',termMonths:12,rateMode:'FIXED',fixedRate:12,margin:0,residual:0,recurringSkipMonths:[],dayCount:'ACTUAL_365',repriceMode:'FIXED_INSTALLMENT',skipMode:'EXTEND_TERM',lumpMode:'MAINTAIN_INSTALLMENT'};
 const pmt=load('src/lib/amortisation/pmt.ts');
 let dates=0;class BoundedDate extends Date{constructor(...args){if(++dates>10000)throw new Error('AUDIT_DATE_BUDGET_EXCEEDED');super(...args)}}
 const engine=load('src/lib/amortisation/engine.ts',{'./pmt':pmt},{Date:BoundedDate});
 const normal=engine.amortise(inputs,[],[]);dates=0;let allSkipOutcome;
 try{allSkipOutcome={rows:engine.amortise({...inputs,recurringSkipMonths:Array.from({length:12},(_,i)=>i+1)},[],[]).length};}catch(e){allSkipOutcome={error:e.message,dateConstructions:dates};}
 results.loanTermination={normalRows:normal.length,allSkipOutcome,confirmed:allSkipOutcome.error==='AUDIT_DATE_BUDGET_EXCEEDED',note:'Date-construction safety budget aborts a nonterminating schedule before excessive resource use; no production inputs or external requests.'};
 fs.writeFileSync('docs/audits/database-reproductions.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
 }finally{await db.end()}
})().catch(e=>{console.error(e);process.exit(1)});
