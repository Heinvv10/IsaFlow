import {beforeAll,afterAll,expect,it} from 'vitest';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
import type {RpcReply} from '../mcp-http/client';
import type {getConnectionPermissions} from '@/modules/accounting/services/controls/connectionPermissionsService';
let f:Awaited<ReturnType<typeof operationalCheckHttpFixture>>;
beforeAll(async()=>{f=await operationalCheckHttpFixture();},30000);afterAll(async()=>{if(f)await f.close();});
type View=Awaited<ReturnType<typeof getConnectionPermissions>>;
function dto(reply:RpcReply):View{expect(reply.result?.isError).not.toBe(true);return JSON.parse(reply.result!.content!.map(row=>row.text).join('\n')) as View;}
const call=(index=0,args:Record<string,unknown>={})=>f.client.rpc(f.f.u1.tokens[index]!.raw,'tools/call',{name:'connection_permissions',arguments:args});
it('discovers and reads only the actual authenticated connection without read:access',async()=>{
 await f.pool.query("UPDATE personal_access_tokens SET scopes=array_remove(scopes,'read:access') WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);
 const manifest=await f.client.rpc(f.f.u1.tokens[0]!.raw,'tools/list');
 expect(manifest.result?.tools?.filter(tool=>tool.name==='connection_permissions')).toHaveLength(1);
 const first=dto(await call()),second=dto(await call(1));
 expect(first).toMatchObject({companyId:f.f.companyA,personId:f.f.u1.id,authMethod:'pat',connectionId:f.f.u1.tokens[0]!.id});
 expect(second.personId).toBe(first.personId);expect(second.connectionId).toBe(f.f.u1.tokens[1]!.id);
 expect(first.permissions).not.toContain('read:access');expect(first.permissions).toContain('read:bank-tx');
 const serialized=JSON.stringify([first,second]);for(const token of f.f.u1.tokens)expect(serialized).not.toContain(token.raw);
 expect(serialized).not.toMatch(/token_hash|secret|idempotency_key/);
 expect((await call(0,{company_id:f.f.companyB})).result?.isError).toBe(true);
});
it('reflects current module denial and role changes with the same bearer',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',false,false)",[f.f.companyA,f.f.u1.id]);
 try{
  const denied=dto(await call());expect(denied.permissions).not.toContain('read:bank-tx');
  expect(denied.denied).toContainEqual({permission:'read:bank-tx',reason:'MODULE_DENIED',conditional:false});
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.f.companyA,f.f.u1.id]);}
 await f.pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);
 try{const viewer=dto(await call());expect(viewer.role).toBe('viewer');expect(viewer.permissions).not.toContain('write:bank-tx');}
 finally{await f.pool.query("UPDATE company_users SET role='owner' WHERE company_id=$1 AND user_id=$2",[f.f.companyA,f.f.u1.id]);}
});
it('refuses a revoked stored grant while the same person’s other token still works',async()=>{
 await f.pool.query('UPDATE personal_access_tokens SET revoked_at=now() WHERE company_id=$1 AND id=$2',[f.f.companyA,f.f.u1.tokens[0]!.id]);
 await expect(call()).rejects.toThrow('Unexpected MCP HTTP status 401');expect(dto(await call(1)).connectionId).toBe(f.f.u1.tokens[1]!.id);
});
