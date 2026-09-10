import type {Pool} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
export interface Identity {id:string;companyId:string}
function claims(user:Identity){return{sub:user.id,company_id:user.companyId,role:'authenticated'};}
async function asAppUser<T>(pool:Pool,user:Identity,fn:(client:import('pg').PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims(user)),user.companyId]);
  const result=await fn(client);
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');
  return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export function actorAs<T>(pool:Pool,user:Identity,fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 return asAppUser(pool,user,client=>withControlRequest({client,userId:user.id,companyId:user.companyId,claims:claims(user)},
  {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx())));
}
/** Appends a twin of one committed receipt spelled in the opposite case; the original row is never touched. */
export async function insertCaseVariantReceipt(pool:Pool,user:Identity,effectId:string){
 return asAppUser(pool,user,async client=>{
  const rows=await client.query(`INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
   SELECT company_id,gen_random_uuid(),gen_random_uuid(),operation,entity_type,
    CASE WHEN entity_id=lower(entity_id) THEN upper(entity_id) ELSE lower(entity_id) END,binding_hash,result,clock_timestamp()
   FROM control_operation_effects WHERE company_id=$1 AND id=$2 RETURNING id,entity_id`,[user.companyId,effectId]);
  if(rows.rowCount!==1)throw new Error('Receipt to twin not found');
  return rows.rows[0] as {id:string;entity_id:string};
 });
}
export async function receiptsFor(pool:Pool,company:string,intentId:string,operation:string){
 return (await pool.query('SELECT id,entity_id,result FROM control_operation_effects WHERE company_id=$1 AND lower(entity_id)=$2 AND operation=$3 ORDER BY id',
  [company,intentId.toLowerCase(),operation])).rows as {id:string;entity_id:string;result:Record<string,unknown>}[];
}
export async function effectRows(pool:Pool,company:string){
 return (await pool.query('SELECT to_jsonb(e) AS row FROM control_operation_effects e WHERE company_id=$1 ORDER BY id',[company])).rows;
}
/** Whole-row images of every financial table these five operations can write. */
export async function ledgerRows(pool:Pool,company:string){
 const rows=async(text:string)=>(await pool.query(text,[company])).rows;
 return{
  journals:await rows('SELECT to_jsonb(j) AS row FROM gl_journal_entries j WHERE company_id=$1 ORDER BY id'),
  lines:await rows('SELECT to_jsonb(l) AS row FROM gl_journal_lines l WHERE company_id=$1 ORDER BY id'),
  banks:await rows('SELECT to_jsonb(b) AS row FROM bank_transactions b WHERE company_id=$1 ORDER BY id'),
  payments:await rows('SELECT to_jsonb(p) AS row FROM customer_payments p WHERE company_id=$1 ORDER BY id'),
  allocations:await rows('SELECT to_jsonb(a) AS row FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id WHERE p.company_id=$1 ORDER BY a.id'),
  invoices:await rows('SELECT to_jsonb(i) AS row FROM customer_invoices i WHERE company_id=$1 ORDER BY id'),
  assignments:await rows('SELECT to_jsonb(c) AS row FROM payroll_employee_components c JOIN payroll_employees e ON e.id=c.employee_id WHERE e.company_id=$1 ORDER BY c.id'),
 };
}
