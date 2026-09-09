import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {closeFiscalYear} from '@/modules/accounting/services/gl/yearEndCloseService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
let fixture:ForensicFixture;
const period=randomUUID(),journal=randomUUID();
const accounts=['asset','revenue','equity'].map(type=>({id:randomUUID(),type}));
async function actor<T>(person:'u1'|'u3',fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Transaction did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET financial_year_start=1,default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 for(const account of accounts)await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
  VALUES($1,$2,$3,'Synthetic year account',$4,$5,$6,true,true,3)`,[account.id,fixture.companyA,account.id.slice(0,12),account.type,account.type==='equity'?'retained_earnings':null,account.type==='asset'?'debit':'credit']);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$2,'Synthetic closed year',12,2025,'2025-01-01','2025-12-31','closed')`,[period,fixture.companyA]);
 // Fixture-only seed of a historical posted sale; the tested close must use the actual app_user shared service.
 await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
  VALUES($1,$2,'SYNTHETIC-YEAR','2025-06-30',$3,'Synthetic prior sale','manual','posted',$4)`,[journal,fixture.companyA,period,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
  VALUES($1,$2,$3,123.45,0),($1,$2,$4,0,123.45)`,[fixture.companyA,journal,accounts[0]!.id,accounts[1]!.id]);
});
afterAll(async()=>{await pool.end();});
it('previews the exact same closing plan without events or closing journal',async()=>{
 const result=await actor('u1',()=>closeFiscalYear(fixture.companyA,'2025',fixture.u1.id,{dryRun:true}));
 expect(result).toMatchObject({dryRun:true,netIncomeExact:'123.45',preview:{exactTotal:'123.45'}});
 expect((await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",[fixture.companyA])).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
 await expect(actor('u3',()=>closeFiscalYear(fixture.companyA,'2025',fixture.u3.id))).rejects.toThrow('match');
});
it('posts a balanced closing journal into the closed final period and locks its year exactly once',async()=>{
 const result=await actor('u1',()=>closeFiscalYear(fixture.companyA,'2025',fixture.u1.id));
 expect(result).toMatchObject({netIncomeExact:'123.45',closingEntry:{status:'posted'}});
 expect(await actor('u1',()=>closeFiscalYear(fixture.companyA,'2025',fixture.u1.id))).toEqual(result);
 const journals=(await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='year_end'",[fixture.companyA])).rows;
 expect(journals).toHaveLength(1);
 const balance=(await pool.query('SELECT sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,journals[0].id])).rows[0];
 expect(balance).toEqual({debit:'123.45',credit:'123.45'});
 expect((await pool.query('SELECT status FROM fiscal_periods WHERE company_id=$1 AND id=$2',[fixture.companyA,period])).rows[0].status).toBe('locked');
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND operation='year.close'",[fixture.companyA])).rows).toHaveLength(1);
});
