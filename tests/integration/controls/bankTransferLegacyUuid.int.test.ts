import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {executeBankTransfer,type BankTransferResult} from '@/modules/accounting/services/bank/bankTransferPostingService';
interface Retained {companyId:string;personId:string;ref:{entityId:string};result:BankTransferResult;approval:string;keys:{encryption:string;fingerprint:string}}
const path=process.env.ISAFLOW_BANK_TRANSFER_LEGACY_UUID_FIXTURE;
let retained:Retained,pool:Pool;
beforeAll(async()=>{
 if(!path)return;
 retained=JSON.parse(await readFile(path,'utf8')) as Retained;
 process.env.ENCRYPTION_KEY=retained.keys.encryption;process.env.CONTROL_FINGERPRINT_KEY=retained.keys.fingerprint;
 pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,ssl:false,max:2});
});
afterAll(async()=>{await pool?.end();});
async function execute(id:string){
 const client=await pool.connect(),{companyId,personId}=retained;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:personId,company_id:companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),companyId]);
  const result=await withControlRequest({client,userId:personId,companyId,claims},{personId,companyId,authMethod:'cookie'},()=>executeBankTransfer(companyId,personId,id));
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic retry did not commit');
  return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
it.skipIf(!path)('replays a genuine baseline uppercase effect without rewriting its immutable evidence',async()=>{
 const before=(await pool.query("SELECT to_jsonb(e) AS row FROM control_operation_effects e WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND lower(entity_id)=$2",[retained.companyId,retained.ref.entityId.toLowerCase()])).rows;
 const approvalBefore=(await pool.query('SELECT to_jsonb(a) AS row FROM control_operation_approvals a WHERE company_id=$1 AND id=$2::uuid',[retained.companyId,retained.approval])).rows;
 expect(approvalBefore).toHaveLength(1);
 expect(before).toHaveLength(1);expect(before[0].row.entity_id).toBe(retained.ref.entityId);
 await expect(execute(retained.ref.entityId)).resolves.toEqual(retained.result);
 await expect(execute(retained.ref.entityId.toLowerCase())).resolves.toEqual(retained.result);
 const after=(await pool.query("SELECT to_jsonb(e) AS row FROM control_operation_effects e WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND lower(entity_id)=$2",[retained.companyId,retained.ref.entityId.toLowerCase()])).rows;
 expect(after).toEqual(before);
 expect((await pool.query('SELECT to_jsonb(a) AS row FROM control_operation_approvals a WHERE company_id=$1 AND id=$2::uuid',[retained.companyId,retained.approval])).rows).toEqual(approvalBefore);
 const journals=(await pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_bank_transfer' AND source_record_id=$2::uuid",[retained.companyId,retained.ref.entityId])).rows;
 expect(journals).toEqual([{id:retained.result.journalEntryId}]);
});
