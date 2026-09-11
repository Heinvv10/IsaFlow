import type {Pool} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
export interface Identity {id:string;companyId:string}
function claims(user:Identity){return{sub:user.id,company_id:user.companyId,role:'authenticated'};}
async function asAppUser<T>(pool:Pool,user:Identity,fn:(client:import('pg').PoolClient)=>Promise<T>,isolation?:'repeatable read'):Promise<T>{
 const client=await pool.connect();
 try{
  await client.query(isolation?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims(user)),user.companyId]);
  const result=await fn(client);
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');
  return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export function actorAs<T>(pool:Pool,user:Identity,fn:(ctx:ControlTx)=>Promise<T>,isolation?:'repeatable read'):Promise<T>{
 return asAppUser(pool,user,client=>withControlRequest({client,userId:user.id,companyId:user.companyId,claims:claims(user)},
  {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx())),isolation);
}
/** Uppercases a UUID's leading hex characters to build a "partially capitalized" spelling distinct
 * from both the canonical lowercase id and its fully-uppercased twin. A fixed 8-char prefix is not
 * enough: about (10/16)^8 ≈ 2.3% of random UUIDs have an all-digit first 8 characters, for which
 * uppercasing that slice is a no-op and the "variant" silently equals the original. Widen the
 * uppercased span until it actually differs. */
export function partialCaseVariant(id:string):string{
 for(let end=8;end<=id.length;end++){
  const candidate=`${id.slice(0,end).toUpperCase()}${id.slice(end)}`;
  if(candidate!==id)return candidate;
 }
 throw new Error('Synthetic UUID lacks case distinction');
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
/** Appends a version row spelled as legacy source spelled it; no existing row is edited. */
export async function appendEntityVersion(pool:Pool,user:Identity,entityType:string,entityId:string,version=1){
 return asAppUser(pool,user,async client=>{
  const rows=await client.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
   VALUES($1,$2,$3,$4,$5) RETURNING entity_id`,[user.companyId,entityType,entityId,version,'0'.repeat(64)]);
  if(rows.rowCount!==1)throw new Error('Version row was not appended');
  return rows.rows[0] as {entity_id:string};
 });
}
export async function entityVersions(pool:Pool,company:string,entityType:string,entityId:string){
 return (await pool.query(`SELECT entity_id,version::int AS version FROM control_entity_versions
  WHERE company_id=$1 AND entity_type=$2 AND lower(entity_id)=$3 ORDER BY entity_id`,[company,entityType,entityId.toLowerCase()])).rows as {entity_id:string;version:number}[];
}
export async function eventSpellings(pool:Pool,company:string,entityType:string,entityId:string){
 const rows=async(table:string,column:string)=>(await pool.query(`SELECT DISTINCT ${column} AS entity_id FROM ${table}
  WHERE company_id=$1 AND entity_type=$2 AND lower(${column})=$3 ORDER BY 1`,[company,entityType,entityId.toLowerCase()])).rows as {entity_id:string}[];
 return{events:(await rows('control_change_events','entity_id')).map(r=>r.entity_id),
  evidence:(await rows('control_protected_evidence','entity_id')).map(r=>r.entity_id)};
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
