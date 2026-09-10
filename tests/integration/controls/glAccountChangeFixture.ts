import {beforeAll,afterAll} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
process.env.ENCRYPTION_KEY='synthetic-gl-change-encryption-key';process.env.CONTROL_FINGERPRINT_KEY='synthetic-gl-change-fingerprint-key';
export const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(async()=>{await pool.end();});
export const glFixture=()=>fixture;
export async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',pat=false):Promise<T>{
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const token=user.tokens[0]!;
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:pat?'pat':'cookie',...(pat?{connectionId:token.id,grantId:token.id,grantedScopes:['read:audit','read:reports','write:accounts']}: {})},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function legacy(parent:string|null=null,level=1,company=fixture.companyA){
 const id=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,parent_account_id) VALUES($1,$2,left($1::uuid::text,12),'Synthetic legacy GL','asset','debit',$3,$4)",[id,company,level,parent]);return id;
}
export async function changes(id:string,company=fixture.companyA){
 const rows=(await pool.query("SELECT e.*,p.ciphertext,p.key_id,p.envelope_version FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_id=e.entity_id AND p.entity_type=e.entity_type WHERE e.company_id=$1 AND e.entity_type='gl_account' AND e.entity_id=$2 ORDER BY e.new_version",[company,id])).rows;
 return rows.map(row=>({...row,values:openProtectedChange({version:row.envelope_version,keyId:row.key_id,ciphertext:row.ciphertext}) as {before:Record<string,unknown>|null;after:Record<string,unknown>|null}}));
}
