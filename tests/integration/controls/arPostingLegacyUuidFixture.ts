import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {seedArCompany,seedArInvoice} from './arUuidFixture';
/**
 * Run only from the isolated pre-normalization baseline (fad0f57f7). The customer-invoice REST body and the
 * MCP finalize tool both pass the caller's id unchanged, so old code retained an uppercase receipt this way.
 */
const output=process.argv[2];if(!output)throw new Error('Synthetic artifact output required');
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
try{
 const f=await provisionForensicFixture(config);
 const customer=await seedArCompany(pool,f.companyA),invoice=await seedArInvoice(pool,f.companyA,customer,f.u1.id),upper=invoice.toUpperCase();
 const client=await pool.connect();let result:unknown;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:f.u1.id,company_id:f.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),f.companyA]);
  result=await withControlRequest({client,userId:f.u1.id,companyId:f.companyA,claims},{personId:f.u1.id,companyId:f.companyA,authMethod:'cookie'},
   ()=>{requireControlTx();return approveCustomerInvoice(f.companyA,upper,f.u1.id);});
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic baseline approval did not commit');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const effects=(await pool.query("SELECT entity_id,result FROM control_operation_effects WHERE company_id=$1 AND entity_type='customer_invoice' AND lower(entity_id)=$2",[f.companyA,invoice])).rows;
 if(effects.length!==1||effects[0].entity_id!==upper||effects[0].result.id!==upper)throw new Error('Baseline uppercase invoice receipt was not retained');
 await writeFile(output,JSON.stringify({fixture:{companyA:f.companyA,u1:{id:f.u1.id,companyId:f.u1.companyId}},invoice,result,
  keys:{encryption:process.env.ENCRYPTION_KEY,fingerprint:process.env.CONTROL_FINGERPRINT_KEY}}),{mode:0o600});
}finally{await pool.end();}
