import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
/** Transaction-local failure injection. Always rolls back DDL, even if the callback unexpectedly succeeds. */
export async function withBank39MissingPayment<T>(pool:Pool,f:ForensicFixture,fn:()=>Promise<T>){
 const client=await pool.connect(),user=f.u1;let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  await client.query("SELECT set_config('bank39.company_id',$1,true)",[f.companyA]);
  await client.query("CREATE FUNCTION pg_temp.bank39_drop_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id=current_setting('bank39.company_id')::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$");
  await client.query('CREATE TRIGGER bank39_drop_payment BEFORE INSERT ON customer_payments FOR EACH ROW EXECUTE FUNCTION pg_temp.bank39_drop_payment()');
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:f.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
  return await withControlRequest({client,userId:user.id,companyId:f.companyA,claims},{personId:user.id,companyId:f.companyA,authMethod:'cookie'},fn);
 }finally{try{if(begun)await client.query('ROLLBACK');}finally{client.release();}}
}
