import {createServer} from 'node:http';
import {listenExceptionServer,rethrowAfterExceptionCleanup} from './exceptionHttpLifecycle';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {transferControlFixture} from '../controls/bankTransferControlFixture';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {mcpHttpClient} from './client';
export async function exceptionHttpFixture(){
 const jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.JWT_SECRET=jwtKey;
 process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;process.env.DATABASE_SSL='disable';
 const f=await transferControlFixture();let server:ReturnType<typeof createServer>|undefined;
 async function close(){
  const results=await Promise.allSettled([Promise.resolve().then(()=>server?.listening?new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();}):undefined),f.close(),
   import('@/lib/mcp/invocationStore').then(m=>m.closeInvocationPool()),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end())]);
  const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Synthetic exception cleanup');
 }
 try{
  await f.pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
  for(const [company,person] of [[f.f.companyA,f.f.u1.id],[f.f.companyB,f.f.u3.id]])await f.pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[company,person]);
  const {mcpRegistry}=await import('@/lib/mcp/toolIndex'),{forensicExceptionTools}=await import('@/lib/mcp/tools/forensicExceptions');
  const missing=forensicExceptionTools.filter(tool=>!mcpRegistry.listTools().some(t=>t.name===tool.name));
  if(missing.length)throw new Error(`Default registry lacks exception tools: ${missing.map(tool=>tool.name).join(", ")}`);
  const mcp=(await import('../../../pages/api/mcp/index')).default,rest=(await import('../../../pages/api/accounting/control-exceptions')).default;
  server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1');void apiResolver(req,res,Object.fromEntries(url.searchParams),{default:url.pathname==='/api/mcp'?mcp:rest},
   {previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname).catch(()=>{res.statusCode=500;res.end('Synthetic exception HTTP failure');});});
  await listenExceptionServer(server);const address=server.address();if(!address||typeof address==='string')throw new Error('Missing synthetic listener');
  const origin=`http://127.0.0.1:${address.port}`,client=mcpHttpClient(origin);
  const rpc=(name:string,args:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1',index=0)=>client.rpc(f.f[person].tokens[index]!.raw,'tools/call',{name,arguments:args});
  async function refusal(name:string,args:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1',index=0){
   await new Promise(resolve=>setTimeout(resolve,650));
   const response=await fetch(`${origin}/api/mcp`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',Authorization:`Bearer ${f.f[person].tokens[index]!.raw}`},
    body:JSON.stringify({jsonrpc:'2.0',id:777,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(15000)});
   return{status:response.status,body:await response.json()};
  }
  async function request(body:unknown,person:'u1'|'u2'|'u3'='u1',validCsrf=true){const user=f.f[person];
   const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`${origin}/api/accounting/control-exceptions`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   return{status:response.status,body:await response.json()};
  }
  return{...f,rpc,refusal,request,close};
 }catch(error){return rethrowAfterExceptionCleanup(error,close);}
}
