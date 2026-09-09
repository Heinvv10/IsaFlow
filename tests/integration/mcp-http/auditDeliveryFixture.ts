import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {mcpHttpClient} from './client';
export async function auditDeliveryFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const fixture=await provisionForensicFixture(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
 try{
 await pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
 for(const company of [fixture.companyA,fixture.companyB])await pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[company,fixture.u1.id]);
 const journal=randomUUID(),bank=randomUUID(),account=randomUUID(),attachment=randomUUID(),bytes=Buffer.from('Original synthetic retained MCP attachment');
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,description) VALUES($1::uuid,$2,$1::text,'2026-09-09','posted','auto_migration',$3,'Original synthetic MCP journal')",[journal,fixture.companyA,fixture.u1.id]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic HTTP bank','asset','debit',3,true)",[account,fixture.companyA]);
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount) VALUES($1,$2,$3,'2026-09-09',100)",[bank,fixture.companyA,account]);
 await pool.query('INSERT INTO bank_transaction_attachments(id,bank_transaction_id,file_url,file_size) VALUES($1,$2,$3,$4)',[attachment,bank,`data:text/plain;base64,${bytes.toString('base64')}`,bytes.length]);
 const route=(await import('../../../pages/api/mcp/index')).default;
 const server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:route},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,'/api/mcp').catch(()=>{res.statusCode=500;res.end('Synthetic HTTP failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback unavailable');
 const client=mcpHttpClient(`http://127.0.0.1:${address.port}`);let calls=0;
 async function rpc(name:string,args:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1',secondToken=false){calls++;return client.rpc(fixture[person].tokens[secondToken?1:0]!.raw,'tools/call',{name,arguments:args});}
 async function call<T>(name:string,args:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1'):Promise<T>{
  const reply=await rpc(name,args,person);const text=reply.result?.content?.map(item=>item.text).join('\n')??'';
  if(reply.result?.isError)throw new Error(`MCP ${name} refused: ${text}`);return JSON.parse(text) as T;
 }
 async function close(){
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await (await import('@/lib/mcp/invocationStore')).closeInvocationPool();
  await (await import('@/lib/auth/authPool')).getAuthPool().end();
  await (await import('@/lib/neon')).getPoolForTests().end();await pool.end();
 }
 return{fixture,pool,call,rpc,close,journal,bank,attachment,bytes,calls:()=>calls};
 }catch(error){await pool.end();throw error;}
}
