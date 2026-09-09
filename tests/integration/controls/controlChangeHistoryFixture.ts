import {afterAll,beforeAll} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
process.env.ENCRYPTION_KEY='synthetic-history-encryption-key-only';process.env.CONTROL_FINGERPRINT_KEY='synthetic-history-fingerprint-key-only';
export const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:10000});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(async()=>{await pool.end();});
export const historyFixture=()=>fixture;
export async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',pat=false):Promise<T>{
 const user=fixture[person],company=user.companyId,client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:company,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),company]);
  const token=user.tokens[0]!;
  const result=await withControlRequest({client,userId:user.id,companyId:company,claims},
   {personId:user.id,companyId:company,authMethod:pat?'pat':'cookie',...(pat?{connectionId:token.id,grantId:token.id,grantedScopes:['read:audit','read:contacts','read:reports']}: {})},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function supplier(company=fixture.companyA){const id=randomUUID();await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic history')",[id,company]);return id;}
export async function event(id:string,version:number,after:Record<string,unknown>,type='supplier',pat=false){
 return actor(ctx=>recordCommittedChange(ctx,{entityType:type,entityId:id,previousVersion:version===1?null:version-1,newVersion:version,action:version===1?'baseline_observed':'updated',accountingDate:'2026-09-10',before:version===1?null:{version:version-1},after,bindingHash:null,protectedEvidenceRef:null}), 'u1',pat);
}
