import {randomUUID} from 'node:crypto';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {bankRestFixture} from './bankRestFixture';
export async function bankDimensionsFixture(){
 const f=await bankRestFixture();
 async function actor<T>(fn:()=>Promise<T>){
  const client=await f.pool.connect(),user=f.fixture.u1,claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async function dimensions(company=f.fixture.companyA){
  const cc1Id=randomUUID(),cc2Id=randomUUID(),buId=randomUUID();
  for(const [id,type] of [[cc1Id,'cc1'],[cc2Id,'cc2']])await f.pool.query("INSERT INTO cost_centres(id,company_id,code,name,cc_type,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank dimension',$3,true)",[id,company,type]);
  await f.pool.query("INSERT INTO business_units(id,company_id,code,name,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank business unit',true)",[buId,company]);
  return{cc1Id,cc2Id,buId};
 }
 return{...f,actor,dimensions};
}
