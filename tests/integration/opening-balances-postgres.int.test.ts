import { readFileSync } from 'node:fs';
import * as journalService from '../../src/modules/accounting/services/gl/journalEntryService';
import { getTrialBalanceReport } from '../../src/modules/accounting/services/gl/trialBalanceService';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import openingBalances from '../../pages/api/accounting/opening-balances';
import exportBalances from '../../pages/api/accounting/opening-balances-export';
import setupGuide from '../../pages/api/accounting/setup-guide';
import { assertDisposable,request,response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const first=crypto.randomUUID(),second=crypto.randomUUID(),user=crypto.randomUUID();
const debit=crypto.randomUUID(),credit=crypto.randomUUID(),foreign=crypto.randomUUID();
const period=crypto.randomUUID();const companies=[first,second];
let token='';
beforeAll(async()=>{
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',[first,'Opening balance fixture',second,'Foreign opening fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[first,user]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Opening fixture',1,2026,'2026-01-01','2026-12-31','open')",[period,first]);
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
    VALUES($1,$4,'1100','Opening asset','asset','debit',3,true),($2,$4,'3300','Opening equity','equity','credit',3,true),($3,$5,'1100','Foreign asset','asset','debit',3,true)`,[debit,credit,foreign,first,second]);
  token=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
afterAll(async()=>{
  try{
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id=ANY($1::uuid[])',[[debit,credit,foreign]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=$1',[user]);
  }finally{await pool.end();}
});
type Balance={accountId:string;debit:number|string;credit:number|string};
async function post(balances:Balance[],company=first){
  const req=request({'sb-access-token':token,active_company_id:company},'POST');
  req.url='/api/accounting/opening-balances';req.body={balances};
  const result=response();await openingBalances(req,result.res);return result;
}
it('posts valid opening balances with a covering period and reconciled account cache',async()=>{
  const result=await post([{accountId:debit,debit:100,credit:0},{accountId:credit,debit:0,credit:100}]);
  expect(result.state.statusCode).toBe(200);
  const entries=(await pool.query('SELECT id,status,fiscal_period_id FROM gl_journal_entries WHERE company_id=$1',[first])).rows;
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({status:'posted',fiscal_period_id:period});
  const totals=(await pool.query('SELECT sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[first,entries[0].id])).rows[0];
  expect(totals).toEqual({debit:'100.00',credit:'100.00'});
  const cached=(await pool.query('SELECT gl_account_id,balance::text FROM gl_account_balances WHERE fiscal_period_id=$1 ORDER BY balance DESC',[period])).rows;
  expect(cached).toEqual([{gl_account_id:debit,balance:'100.00'},{gl_account_id:credit,balance:'-100.00'}]);
  expect(await getTrialBalanceReport(first,period)).toMatchObject({balanced:true,totalDebit:100,totalCredit:100,difference:0});
});
it('exports saved balances and detects setup completion in the selected company',async()=>{
  const req=request({'sb-access-token':token,active_company_id:first},'GET');
  const exported=response();
  Object.assign(exported.state,{send(body:unknown){exported.state.body=body;return exported.state;}});
  await exportBalances(req,exported.res);
  expect(exported.state.statusCode).toBe(200);
  expect.soft(exported.state.body).toContain('"1100","Opening asset","asset","debit",100.00,0.00');
  const setup=response();await setupGuide(req,setup.res);
  expect(setup.state.statusCode).toBe(200);
  expect(JSON.stringify(setup.state.body)).toContain('opening-balances');
});
it('rejects a foreign account before journal or cache writes',async()=>{
  const before=(await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[first])).rows.length;
  const result=await post([{accountId:foreign,debit:100,credit:0},{accountId:credit,debit:0,credit:100}]);
  expect(result.state.statusCode).toBe(400);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[first])).rows).toHaveLength(before);
  expect((await pool.query('SELECT gl_account_id FROM gl_account_balances WHERE gl_account_id=$1',[foreign])).rows).toEqual([]);
});

async function journalCount(){return (await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[first])).rows.length;}
const pair=(value:number|string=100):Balance[]=>[{accountId:debit,debit:value,credit:0},{accountId:credit,debit:0,credit:value}];
it.each(['Infinity','NaN',-1,0,0.001])('rejects invalid amount %s before writes',async value=>{
  const count=await journalCount();expect((await post(pair(value))).state.statusCode).toBe(400);expect(await journalCount()).toBe(count);
});
it('rejects a one-cent imbalance and a line carrying both debit and credit',async()=>{
  const count=await journalCount();
  expect((await post([{accountId:debit,debit:100,credit:0},{accountId:credit,debit:0,credit:99.99}])).state.statusCode).toBe(400);
  expect((await post([{accountId:debit,debit:100,credit:100},{accountId:credit,debit:1,credit:1}])).state.statusCode).toBe(400);
  expect(await journalCount()).toBe(count);
});
it('missing, inactive and non-posting accounts are refused',async()=>{
  const count=await journalCount();
  expect((await post([{accountId:crypto.randomUUID(),debit:100,credit:0},pair()[1]!])).state.statusCode).toBe(400);
  await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[first,debit]);
  try{expect((await post(pair())).state.statusCode).toBe(400);}finally{await pool.query('UPDATE gl_accounts SET is_active=true,level=2 WHERE company_id=$1 AND id=$2',[first,debit]);}
  try{expect((await post(pair())).state.statusCode).toBe(400);}finally{await pool.query('UPDATE gl_accounts SET level=3 WHERE company_id=$1 AND id=$2',[first,debit]);}
  expect(await journalCount()).toBe(count);
});
it('viewer role cannot post and closed periods do not accept opening balances',async()=>{
  const count=await journalCount();
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[first,user]);
  try{expect((await post(pair())).state.statusCode).toBe(403);}finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[first,user]);}
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[first,period]);
  try{expect((await post(pair())).state.statusCode).toBe(400);}finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[first,period]);}
  expect(await journalCount()).toBe(count);
});
it('a company with no periods is refused without inventing a fiscal calendar',async()=>{
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[second,user]);
  const result=await post([{accountId:foreign,debit:100,credit:0},{accountId:foreign,debit:0,credit:100}],second);
  expect(result.state.statusCode).toBe(400);
  expect((await pool.query('SELECT id FROM fiscal_periods WHERE company_id=$1',[second])).rows).toEqual([]);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[second])).rows).toEqual([]);
  // Membership of both companies does not authorize a foreign account in the selected one.
  expect((await post([{accountId:foreign,debit:100,credit:0},pair()[1]!])).state.statusCode).toBe(400);
});
it('a failure after real draft and line creation rolls the complete journal back',async()=>{
  const count=await journalCount();const cached=await getTrialBalanceReport(first,period);
  const failure=vi.spyOn(journalService,'postJournalEntry').mockRejectedValueOnce(new Error('Disposable post-stage fault'));
  try{expect((await post(pair(7))).state.statusCode).toBe(500);}finally{failure.mockRestore();}
  expect(await journalCount()).toBe(count);expect(await getTrialBalanceReport(first,period)).toEqual(cached);
  expect((await pool.query('SELECT jl.id FROM gl_journal_lines jl LEFT JOIN gl_journal_entries je ON je.id=jl.journal_entry_id AND je.company_id=jl.company_id WHERE jl.company_id=$1 AND je.id IS NULL',[first])).rows).toEqual([]);
});
it('simultaneous opening submissions produce distinct balanced journals and matching TB/cache',async()=>{
  const results=await Promise.all([post(pair(10)),post(pair(20))]);
  expect(results.map(result=>result.state.statusCode)).toEqual([200,200]);
  const rows=(await pool.query('SELECT entry_number FROM gl_journal_entries WHERE company_id=$1',[first])).rows;
  expect(new Set(rows.map(row=>row.entry_number)).size).toBe(rows.length);
  expect(await getTrialBalanceReport(first,period)).toMatchObject({balanced:true,totalDebit:130,totalCredit:130});
  const cached=(await pool.query('SELECT gl_account_id,balance::text FROM gl_account_balances WHERE fiscal_period_id=$1 ORDER BY balance DESC',[period])).rows;
  expect(cached).toEqual([{gl_account_id:debit,balance:'130.00'},{gl_account_id:credit,balance:'-130.00'}]);
});
it('migration501 resolves a covering period on INSERT but does not invent a missing one',async()=>{
  const covering=(await pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,created_by,source) VALUES($1,'2026-06-01',$2,'manual') RETURNING fiscal_period_id",[first,user])).rows[0];
  expect(covering.fiscal_period_id).toBe(period);
  const missing=(await pool.query("INSERT INTO gl_journal_entries(company_id,entry_date,created_by,source) VALUES($1,'1900-01-01',$2,'manual') RETURNING fiscal_period_id",[first,user])).rows[0];
  expect(missing.fiscal_period_id).toBeNull();
});
it('account deactivation and period closure wait until the journal has posted',async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const original=journalService.postJournalEntry;
  const spy=vi.spyOn(journalService,'postJournalEntry').mockImplementation(async(...args)=>{entered();await barrier;return original(...args);});
  const accountClient=await pool.connect(),periodClient=await pool.connect();
  let posting:ReturnType<typeof post>|undefined;
  let accountUpdate:ReturnType<typeof accountClient.query>|undefined,periodUpdate:ReturnType<typeof periodClient.query>|undefined;
  try{
    posting=post(pair(5));await ready;
    await accountClient.query('BEGIN');await periodClient.query('BEGIN');
    const accountPid=(await accountClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const periodPid=(await periodClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    accountUpdate=accountClient.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[first,debit]);
    periodUpdate=periodClient.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[first,period]);
    let blocked=0;
    for(let attempt=0;attempt<100;attempt++){
      blocked=Number((await pool.query('SELECT count(*) AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND cardinality(pg_blocking_pids(pid))>0',[[accountPid,periodPid]])).rows[0].n);
      if(blocked===2)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(blocked).toBe(2);release();expect((await posting).state.statusCode).toBe(200);
    await accountUpdate;await periodUpdate;
  }finally{
    release();if(posting)await posting;
    await accountClient.query('ROLLBACK');await periodClient.query('ROLLBACK');
    accountClient.release();periodClient.release();spy.mockRestore();
  }
});

it('historical inventory identifies a privileged synthetic foreign-account row without exposing another company',async()=>{
  // This fixture is inserted by the disposable DB owner, not through the vulnerable route.
  const id=crypto.randomUUID();
  await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,created_by,source,reference) VALUES($1,$2,'2026-01-01',$3,'manual','opening_balance')",[id,first,user]);
  await pool.query('INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,1,0)',[id,first,foreign]);
  const rows=(await pool.query(readFileSync('docs/audits/remediation/K-006/historical-impact.sql','utf8'),[first])).rows;
  expect(rows.find(row=>row.id===id)).toMatchObject({unowned_account_lines:'1',status:'draft'});
  expect((await pool.query(readFileSync('docs/audits/remediation/K-006/historical-impact.sql','utf8'),[second])).rows).toEqual([]);
});
