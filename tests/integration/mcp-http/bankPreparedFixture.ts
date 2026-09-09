import {createServer} from 'node:http';
import {transferRestFixture} from '../controls/bankTransferRestFixture';
import {mcpHttpClient} from './client';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
/** Only source bank rows are seeded. All journals/effects/approvals use actual shared HTTP routes. */
export async function bankPreparedFixture(){
 const f=await transferRestFixture();
 try{
  await f.pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
  for(const company of [f.f.companyA,f.f.companyB])await f.pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[company,f.f.u1.id]);
  const {mcpRegistry}=await import('@/lib/mcp/toolIndex');
  const {bankPreparedOperationTools}=await import('@/lib/mcp/tools/bankPreparedOperations');
  // Explicit composition seam pending root discovery integration; registry/auth/handlers are real.
  const added:string[]=[];
  for(const tool of bankPreparedOperationTools)if(!mcpRegistry.listTools().some(existing=>existing.name===tool.name)){mcpRegistry.register(tool);added.push(tool.name);}
  const route=(await import('../../../pages/api/mcp/index')).default,approvalRoute=(await import('../../../pages/api/accounting/control-approvals')).default;
  const server=createServer((req,res)=>{const approvals=req.url==='/api/accounting/control-approvals';
   void apiResolver(req,res,{}, {default:approvals?approvalRoute:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,
    approvals?'/api/accounting/control-approvals':'/api/mcp').catch(()=>{res.statusCode=500;res.end('Synthetic HTTP fixture failed');});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback MCP fixture unavailable');
  const origin=`http://127.0.0.1:${address.port}`,client=mcpHttpClient(origin);let calls=0;
  async function rpc(name:string,args:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1',secondToken=false){calls++;return client.rpc(f.f[person].tokens[secondToken?1:0]!.raw,'tools/call',{name,arguments:args});}
  async function call<T>(name:string,args:Record<string,unknown>):Promise<T>{
   const reply=await rpc(name,args);const text=reply.result?.content?.map(item=>item.text).join('\n')??'';
   if(reply.result?.isError)throw new Error(`MCP ${name} refused: ${text}`);return JSON.parse(text) as T;
  }
  async function patDecision(approvalId:string){
   const response=await fetch(`${origin}/api/accounting/control-approvals`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',Authorization:`Bearer ${f.f.u1.tokens[1]!.raw}`},
    body:JSON.stringify({action:'decide',approvalId,decision:'approved'}),signal:AbortSignal.timeout(10000)});
   await response.arrayBuffer();return response.status;
  }
  async function close(){
   try{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
   finally{
    await f.close();await (await import('@/lib/mcp/invocationStore')).closeInvocationPool();
    await (await import('@/lib/auth/authPool')).getAuthPool().end();await (await import('@/lib/neon')).getPoolForTests().end();
   }
  }
  return{...f,rpc,call,patDecision,close,calls:()=>calls,testLocalRegistrations:added};
 }catch(error){await f.close();throw error;}
}
