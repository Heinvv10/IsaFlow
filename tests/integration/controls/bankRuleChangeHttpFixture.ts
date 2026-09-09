import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {transferControlFixture} from './bankTransferControlFixture';
import {mcpHttpClient} from '../mcp-http/client';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
export async function bankRuleChangeHttpFixture(){
 const jwtKey=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=jwtKey;
 const f=await transferControlFixture(),csrf=randomBytes(32).toString('hex');
 await f.pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
 await f.pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[f.f.companyA,f.f.u1.id]);
 const seed=(await import('../../../pages/api/accounting/bank-rules-seed')).default,mcp=(await import('../../../pages/api/mcp/index')).default;
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:req.url==='/api/mcp'?mcp:seed},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
  .catch(()=>{res.statusCode=500;res.end('Synthetic rule HTTP failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic rule server unavailable');
 const origin=`http://127.0.0.1:${address.port}`,client=mcpHttpClient(origin);
 async function request(entries:unknown[]){
  const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(f.f.u1.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(`${origin}/api/accounting/bank-rules-seed`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${f.f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify({entries}),signal:AbortSignal.timeout(30000)});
  return{status:response.status,body:await response.json()};
 }
 async function call<T>(name:string,args:Record<string,unknown>){const reply=await client.rpc(f.f.u1.tokens[0]!.raw,'tools/call',{name,arguments:args});
  const text=reply.result?.content?.map(item=>item.text).join('\n')??'';if(reply.result?.isError)throw new Error(text);return JSON.parse(text) as T;
 }
 async function close(){
  try{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
  finally{await f.close();await(await import('@/lib/mcp/invocationStore')).closeInvocationPool();await(await import('@/lib/auth/authPool')).getAuthPool().end();await(await import('@/lib/neon')).getPoolForTests().end();}
 }
 return{...f,request,call,close};
}
