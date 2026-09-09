import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-control-state';
import {getAuthPool} from '@/lib/auth/authPool';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {transferControlFixture} from './bankTransferControlFixture';
import {readBankControlState} from '@/modules/accounting/services/bank/bankControlReadService';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
export async function transferReadFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env)),jwtKey=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=jwtKey;
 const f=await transferControlFixture();
 const server=createServer((req,res)=>{void apiResolver(req,res,Object.fromEntries(new URL(req.url!,'http://127.0.0.1').searchParams),{default:route},
  {previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/accounting/bank-control-state')
  .catch(()=>{res.statusCode=500;res.end('Synthetic reader failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic reader server unavailable');
 async function read(bankTransactionId:string,person:'u1'|'u2'|'u3'='u1',approvalId?:string){
  const user=f.f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const query=new URLSearchParams({bankTransactionId,...(approvalId?{approvalId}:{})});
  const response=await fetch(`http://127.0.0.1:${address.port}/api/accounting/bank-control-state?${query}`,{headers:{cookie:`sb-access-token=${token}; active_company_id=${user.companyId}`},redirect:'error',signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json()};
 }
 async function posted(withOpposite=true){
  const bank=await f.bank(),opposite=withOpposite?await f.bank(f.to,'115.23'):null,prepared=await f.prepare(bank),approval=await f.approve(prepared.operation),effect=await f.execute(prepared.intentId,approval);
  return{bank,opposite,prepared,approval,effect};
 }
 async function withoutEvidence(bankId:string,intentId:string,kind:'event'|'receipt'){
  const client=await f.pool.connect(),user=f.f.u1,claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  try{await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');
   if(kind==='event')await client.query("DELETE FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='bank_allocation.post'",[user.companyId,intentId]);
   else await client.query("DELETE FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_allocation.post'",[user.companyId,intentId]);
   await client.query('SET LOCAL session_replication_role=origin');await client.query('SET LOCAL ROLE app_user');
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   return await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>readBankControlState(requireControlTx(),{bankTransactionId:bankId}));
  }finally{await client.query('ROLLBACK');client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await getAuthPool().end();await f.close();}
 return{...f,read,posted,withoutEvidence,close};
}
