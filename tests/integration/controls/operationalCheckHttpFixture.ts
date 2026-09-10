import {createServer} from 'node:http';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {transferControlFixture} from './bankTransferControlFixture';
import {mcpHttpClient} from '../mcp-http/client';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
export async function operationalCheckHttpFixture(){
 process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;process.env.DATABASE_SSL='disable';
 const f=await transferControlFixture();
 await f.pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
 for(const [company,person] of [[f.f.companyA,f.f.u1.id],[f.f.companyB,f.f.u3.id]])await f.pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[company,person]);
 const handler=(await import('../../../pages/api/mcp/index')).default;
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
  .catch(()=>{res.statusCode=500;res.end('Synthetic detective HTTP failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic server unavailable');
 const client=mcpHttpClient(`http://127.0.0.1:${address.port}`);
 const call=(name:string,args:Record<string,unknown>={},person:'u1'|'u3'='u1')=>client.rpc(f.f[person].tokens[0]!.raw,'tools/call',{name,arguments:args});
 async function close(){
  try{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
  finally{await f.close();await(await import('@/lib/mcp/invocationStore')).closeInvocationPool();await(await import('@/lib/auth/authPool')).getAuthPool().end();await(await import('@/lib/neon')).getPoolForTests().end();}
 }
 return{...f,client,call,close};
}
