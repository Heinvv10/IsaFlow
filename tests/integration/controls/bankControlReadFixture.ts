import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import route from '../../../pages/api/accounting/bank-control-state';
import {bankRestFixture} from './bankRestFixture';
export async function bankControlReadFixture(){
 const f=await bankRestFixture();
 const server=createServer((req,res)=>{const query=Object.fromEntries(new URL(req.url!,'http://127.0.0.1').searchParams);
  void apiResolver(req,res,query,{default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/accounting/bank-control-state')
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
 async function close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await f.close();}
 return{...f,read,prepare,close};
}
