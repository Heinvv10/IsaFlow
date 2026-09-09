import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-control-state';
import approvalRoute from '../../../pages/api/accounting/control-approvals';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {bankRestFixture} from './bankRestFixture';
export async function bankControlReadFixture(){
 const f=await bankRestFixture();
 const server=createServer((req,res)=>{const query=Object.fromEntries(new URL(req.url!,'http://127.0.0.1').searchParams);
  const approval=req.url==='/api/accounting/control-approvals';
  void apiResolver(req,res,query,{default:approval?approvalRoute:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,approval?'/api/accounting/control-approvals':'/api/accounting/bank-control-state')
   .catch(()=>{res.statusCode=500;res.end('Synthetic route failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback fixture unavailable');
 async function read(bankTransactionId:string,intentId?:string,person:'u1'|'u2'|'u3'='u1'){
  const user=f.fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const query=new URLSearchParams({bankTransactionId,...(intentId?{intentId}:{})});
  const response=await fetch(`http://127.0.0.1:${address.port}/api/accounting/bank-control-state?${query}`,{redirect:'error',headers:{cookie:`sb-access-token=${token}; active_company_id=${user.companyId}`},signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json()};
 }
 async function prepare(bankTransactionId?:string,person:'u1'|'u2'='u1'){
  const id=bankTransactionId??await f.source();const response=await f.request({action:'prepare_allocate',bankTransactionId:id,allocationType:'account',contraAccountId:f.contra},person);
  if(response.status!==200)throw new Error(`Preparation failed: ${JSON.stringify(response.body)}`);return{bankTransactionId:id,...response.body.data};
 }
 async function pending(ref:OperationRef){
  const user=f.fixture.u1,token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const csrf=randomBytes(32).toString('hex');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/accounting/control-approvals`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify({action:'request',ref}),signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json()};
 }
 async function withoutReceipt<T>(intentId:string,fn:()=>Promise<T>){
  const client=await f.pool.connect(),user=f.fixture.u1,claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  try{await client.query('BEGIN');await client.query('SET LOCAL session_replication_role=replica');
   await client.query("DELETE FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_allocation.post'",[user.companyId,intentId]);
   await client.query('SET LOCAL session_replication_role=origin');await client.query('SET LOCAL ROLE app_user');
   await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
   return await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);
  }finally{await client.query('ROLLBACK');client.release();}
 }
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await f.close();}
 return{...f,read,prepare,pending,withoutReceipt,close};
}
