import {beforeAll,afterAll,expect,it} from 'vitest';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
import {closeAccessReviewPool} from '@/modules/accounting/services/controls/accessControlReviewPool';
import type {reviewAccessControl} from '@/modules/accounting/services/controls/accessControlReviewService';
import type {RpcReply} from '../mcp-http/client';
let f:Awaited<ReturnType<typeof operationalCheckHttpFixture>>;
beforeAll(async()=>{f=await operationalCheckHttpFixture();},30000);
afterAll(async()=>{
 const results=await Promise.allSettled([f?.close(),closeAccessReviewPool()]);
 const errors=results.filter((row):row is PromiseRejectedResult=>row.status==='rejected');
 if(errors.length)throw new AggregateError(errors.map(row=>row.reason),'Access HTTP cleanup failed');
});
type View=Awaited<ReturnType<typeof reviewAccessControl>>;
function dto(reply:RpcReply):View{
 expect(reply.result?.isError).not.toBe(true);
 return JSON.parse(reply.result!.content!.map(row=>row.text).join('\n')) as View;
}
const call=(args:Record<string,unknown>,person:'u1'|'u3'='u1')=>f.call('access_control_review',args,person);
it('uses the default registered HTTP reader and traverses the complete owned PAT population',async()=>{
 const manifest=await f.client.rpc(f.f.u1.tokens[0]!.raw,'tools/list');
 expect(manifest.result?.tools?.filter(tool=>tool.name==='access_control_review')).toHaveLength(1);
 const baseline=await f.snapshot();
 const expected=(await f.pool.query('SELECT id FROM personal_access_tokens WHERE company_id=$1 ORDER BY id',[f.f.companyA])).rows.map(row=>String(row.id));
 const ids:string[]=[];let cursor:string|null=null;
 do{
  const page=dto(await call({kind:'pat',limit:1,...cursor?{cursor}:{}}));
  expect(page.populationTotal).toBe(expected.length);expect(page.returnedCount).toBe(1);
  ids.push(...page.items.map(row=>row.id));cursor=page.nextCursor;
  const serialized=JSON.stringify(page);
  for(const user of [f.f.u1,f.f.u2,f.f.u3])for(const token of user.tokens)expect(serialized).not.toContain(token.raw);
  expect(serialized).not.toMatch(/token_hash|token_prefix|refresh_token|last_used_ip/);
  expect(ids.length).toBeLessThanOrEqual(expected.length);
 }while(cursor);
 expect(ids).toEqual(expected);expect(await f.snapshot()).toEqual(baseline);
},30000);
it('reports live membership and empty owned OAuth census without borrowing another tenant',async()=>{
 const expected=Number((await f.pool.query('SELECT count(*) FROM company_users WHERE company_id=$1',[f.f.companyA])).rows[0].count);
 const membership=dto(await call({kind:'membership',limit:100}));expect(membership.populationTotal).toBe(expected);
 expect(membership.items.map(row=>row.personId)).toContain(f.f.u2.id);
 expect(membership.items.map(row=>row.personId)).not.toContain(f.f.u3.id);
 expect(dto(await call({kind:'oauth'}))).toMatchObject({populationTotal:0,items:[],nextCursor:null});
 const foreign=dto(await call({kind:'membership'},'u3'));
 expect(foreign.items.map(row=>row.personId)).not.toContain(f.f.u1.id);
 const first=dto(await call({kind:'pat',limit:1}));expect(first.nextCursor).not.toBeNull();
 expect((await call({kind:'pat',limit:1,cursor:first.nextCursor},'u3')).result?.isError).toBe(true);
});
it('refuses current permission and stored scope revocation with the same bearer before returning metadata',async()=>{
 const token=f.f.u1.tokens[0]!,baseline=await f.snapshot();
 dto(await call({kind:'membership'}));
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'access',false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await call({kind:'membership'})).result?.isError).toBe(true);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='access'",[f.f.companyA,f.f.u1.id]);}
 dto(await call({kind:'membership'}));
 const scopes=(await f.pool.query('SELECT scopes FROM personal_access_tokens WHERE company_id=$1 AND id=$2',[f.f.companyA,token.id])).rows[0].scopes as string[];
 await f.pool.query("UPDATE personal_access_tokens SET scopes=array_remove(scopes,'read:access') WHERE company_id=$1 AND id=$2",[f.f.companyA,token.id]);
 try{expect((await call({kind:'membership'})).result?.isError).toBe(true);}
 finally{await f.pool.query('UPDATE personal_access_tokens SET scopes=$3 WHERE company_id=$1 AND id=$2',[f.f.companyA,token.id,scopes]);}
 for(const args of [{kind:'pat',company_id:f.f.companyB},{kind:'pat',role:'owner'},{kind:'pat',limit:101},{kind:'pat',cursor:'invalid'}])expect((await call(args)).result?.isError).toBe(true);
 expect(await f.snapshot()).toEqual(baseline);
},30000);
