import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {glAccountHistoryHttpFixture} from './glAccountHistoryHttpFixture';
import type {RpcReply} from '../mcp-http/client';
import type {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
let f:Awaited<ReturnType<typeof glAccountHistoryHttpFixture>>;
beforeAll(async()=>{f=await glAccountHistoryHttpFixture();},30000);afterAll(async()=>{if(f)await f.close();});
function dto<T>(reply:RpcReply):T{expect(reply.result?.isError).not.toBe(true);return JSON.parse(reply.result!.content!.map(row=>row.text).join('\n')) as T;}
type History=Awaited<ReturnType<typeof readControlEntityHistory>>;
const history=async(id:string)=>dto<History>(await f.call('entity_change_history',{entity_type:'gl_account',entity_id:id}));
it('serves actual cookie REST CRUD through the registered protected history reader',async()=>{
 const response=await f.rest('POST',{accountCode:randomUUID().slice(0,12),accountName:'Synthetic REST original',accountType:'asset',normalBalance:'debit'});expect(response.status).toBe(200);const id=String(response.body.data.id);
 expect((await f.rest('PATCH',{id,accountCode:randomUUID().slice(0,12)},true)).status).toBe(200);
 expect((await f.rest('PUT',{id,accountName:'Synthetic REST edited',accountSubtype:'bank'})).status).toBe(200);
 expect((await f.rest('DELETE',{id},true)).status).toBe(200);
 const page=await history(id);expect(page.available).toBe(true);expect(page.coverage.status).toBe('complete');expect(page.items).toHaveLength(5);
 expect(page.items[0]?.after).toMatchObject({id,account_name:'Synthetic REST original'});
 expect(page.items.at(-1)?.after).toMatchObject({account_name:'Synthetic REST edited',account_subtype:'bank',is_active:false});
 for(const event of page.items){expect(event.actor.personId).toBe(f.f.u1.id);expect(event.actor.provenance).toBe('human');expect(event.actor.connectionId).toBeNull();}
 expect((await f.rest('PUT',{id,accountName:'Invalid CSRF'},true,false)).status).toBe(403);
 expect((await history(id)).items).toHaveLength(5);
});
it('records real MCP CRUD once and rechecks current authority before replay and history',async()=>{
 const args={account_code:randomUUID().slice(0,12),account_name:'Synthetic PAT original',account_type:'asset',idempotency_key:randomUUID()};
 const created=dto<{id:string}>(await f.call('create_gl_account',args));expect(dto<{id:string}>(await f.call('create_gl_account',args)).id).toBe(created.id);
 dto(await f.call('update_gl_account',{account_id:created.id,description:'Recorded through MCP',idempotency_key:randomUUID()}));
 dto(await f.call('deactivate_gl_account',{account_id:created.id,idempotency_key:randomUUID()}));
 const page=await history(created.id);expect(page.items).toHaveLength(3);expect(page.items[0]?.actor.connectionId).toBe(f.f.u1.tokens[0]!.id);expect(page.items[0]?.actor.provenance).toBe('agent');
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'accounts',true,false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await f.call('create_gl_account',args)).result?.isError).toBe(true);}finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='accounts'",[f.f.companyA,f.f.u1.id]);}
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await f.call('entity_change_history',{entity_type:'gl_account',entity_id:created.id})).result?.isError).toBe(true);}finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.f.companyA,f.f.u1.id]);}
 expect((await f.call('entity_change_history',{entity_type:'gl_account',entity_id:created.id},'u3')).result?.isError).toBe(true);
 expect((await history(created.id)).items).toHaveLength(3);
});
