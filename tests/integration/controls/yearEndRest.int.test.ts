import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {yearEndRestFixture} from './yearEndRestFixture';
/**
 * Every year-end outcome as the year-end screen receives it: POST over HTTP,
 * no dryRun, through cookie auth, CSRF and the flow meter. A refusal must be a
 * non-2xx carrying its reason — the screen treats any 2xx as "Year closed".
 */
let f:Awaited<ReturnType<typeof yearEndRestFixture>>;
const accounts=['asset','revenue','equity'].map(type=>({id:randomUUID(),type}));
const company=()=>f.f.companyA;
const close=(yearLabel:string,extra:Record<string,unknown>={})=>f.post({yearLabel,action:'close',...extra});
async function untouched(year:string){
 const periods=(await f.pool.query('SELECT status FROM fiscal_periods WHERE company_id=$1 AND fiscal_year=$2',[company(),Number(year)])).rows.map(r=>r.status);
 const effects=(await f.pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND operation='year.close' AND entity_id=$2",[company(),year])).rows.length;
 const journals=(await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='year_end' AND entry_number=$2",[company(),`YE-${year}`])).rows.length;
 return{periodsLocked:periods.includes('locked'),effects,journals};
}
async function period(year:number,status:'open'|'closed'){
 await f.pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$2,$3,12,$4,$5,$6,$7)`,[randomUUID(),company(),`Synthetic ${year}`,year,`${year}-01-01`,`${year}-12-31`,status]);
}
beforeAll(async()=>{
 f=await yearEndRestFixture();
 await f.pool.query("UPDATE companies SET financial_year_start=1,default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[company()]);
 for(const account of accounts)await f.pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
  VALUES($1,$2,$3,'Synthetic year account',$4,$5,$6,true,true,3)`,[account.id,company(),account.id.slice(0,12),account.type,account.type==='equity'?'retained_earnings':null,account.type==='asset'?'debit':'credit']);
 await period(2021,'open');await period(2022,'closed');await period(2023,'closed');
},60000);
afterAll(async()=>{if(f)await f.close();});
it('a year with no periods is 404',async()=>{
 const reply=await close('2019');
 expect(reply.status).toBe(404);expect(reply.body.success).toBe(false);
});
it('open periods are 400 and name how many',async()=>{
 const reply=await close('2021');
 expect(reply.status).toBe(400);expect(reply.body.error?.message).toMatch(/1 periods still open/);
});
it('periods that are not the financial year are refused with the real reason, not 200 "closed"',async()=>{
 await f.pool.query('UPDATE companies SET financial_year_start=3 WHERE id=$1',[company()]);
 try{
  for(const dryRun of [false,true]){
   const reply=await close('2022',dryRun?{dryRun}:{});
   expect(reply.status,`dryRun=${dryRun} ${JSON.stringify(reply.body)}`).toBe(409);
   expect(reply.body.success).toBe(false);
   expect(reply.body.error?.message).toMatch(/2022-01-01 to 2022-12-31/);
   expect(reply.body.error?.message).toMatch(/2021-03-01 to 2022-02-28/);
   expect(reply.body.error?.message).toMatch(/nothing was closed/i);
  }
 }finally{await f.pool.query('UPDATE companies SET financial_year_start=1 WHERE id=$1',[company()]);}
 expect(await untouched('2022')).toEqual({periodsLocked:false,effects:0,journals:0});
});
it('a missing retained earnings role is 400',async()=>{
 await f.pool.query('UPDATE gl_accounts SET is_system_account=false WHERE company_id=$1 AND id=$2',[company(),accounts[2]!.id]);
 try{
  const reply=await close('2022');
  expect(reply.status).toBe(400);expect(reply.body.error?.message).toMatch(/Retained Earnings/);
 }finally{await f.pool.query('UPDATE gl_accounts SET is_system_account=true WHERE company_id=$1 AND id=$2',[company(),accounts[2]!.id]);}
});
it('an ambiguous retained earnings role is 400 and names the accounts',async()=>{
 const second=randomUUID();
 await f.pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
  VALUES($1,$2,$3,'Synthetic second retained','equity','retained_earnings','credit',true,true,3)`,[second,company(),second.slice(0,12)]);
 try{
  const reply=await close('2022');
  expect(reply.status).toBe(400);expect(reply.body.error?.message).toContain(second.slice(0,12));
 }finally{await f.pool.query('DELETE FROM gl_accounts WHERE company_id=$1 AND id=$2',[company(),second]);}
 expect(await untouched('2022')).toEqual({periodsLocked:false,effects:0,journals:0});
});
it('an eligible year closes with 200',async()=>{
 const reply=await close('2023');
 expect(reply.status,JSON.stringify(reply.body)).toBe(200);
 expect(reply.body.data?.message).toMatch(/Year 2023 closed/);
 expect((await untouched('2023')).periodsLocked).toBe(true);
});
it('a close bound by an approval policy is 409 on the preview AND the live close, never a 500',async()=>{
 await f.pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,$2,'Synthetic year approval','fiscal_year','amount','any',0,'admin')`,[randomUUID(),company()]);
 for(const dryRun of [true,false]){
  const reply=await close('2022',dryRun?{dryRun}:{});
  expect(reply.status,`dryRun=${dryRun} ${JSON.stringify(reply.body)}`).toBe(409);
  expect(reply.body.error?.message).toMatch(/independent approval is required/i);
 }
 expect(await untouched('2022')).toEqual({periodsLocked:false,effects:0,journals:0});
});
it('an approvalId the close cannot use is a caller error, not a 500, live or previewed',async()=>{
 for(const dryRun of [true,false]){
  const reply=await close('2022',{...(dryRun?{dryRun}:{}),approvalId:randomUUID()});
  expect(reply.status,`dryRun=${dryRun} ${JSON.stringify(reply.body)}`).toBe(409);
  expect(reply.body.error?.message).toMatch(/approval/i);
 }
 expect(await untouched('2022')).toEqual({periodsLocked:false,effects:0,journals:0});
});
