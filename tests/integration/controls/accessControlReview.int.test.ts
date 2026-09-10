import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {reviewAccessControl} from '@/modules/accounting/services/controls/accessControlReviewService';
import {getAccessReviewPool,closeAccessReviewPool} from '@/modules/accounting/services/controls/accessControlReviewPool';
import {getAuthPool} from '@/lib/auth/authPool';
let f:Awaited<ReturnType<typeof transferControlFixture>>,ownGrant:string,foreignGrant:string;
beforeAll(async()=>{
 process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;process.env.DATABASE_SSL='disable';process.env.AUTH_POOL_MAX='2';
 f=await transferControlFixture();const app=randomUUID();ownGrant=randomUUID();foreignGrant=randomUUID();
 await f.pool.query("INSERT INTO oauth_apps(id,name,redirect_uris,client_id,client_secret_hash,client_secret_prefix,owner_user_id) VALUES($1,'Synthetic metadata',ARRAY['http://localhost/callback'],$1::text,'synthetic-private-hash','synthetic-private-prefix',$2)",[app,f.f.u2.id]);
 for(const [id,user] of [[ownGrant,f.f.u2],[foreignGrant,f.f.u3]] as const)await f.pool.query("INSERT INTO oauth_authorisations(id,oauth_app_id,user_id,company_id,scopes,access_token_hash,access_token_prefix,access_token_expires_at,refresh_token_hash,refresh_token_prefix,refresh_token_expires_at) VALUES($1,$2,$3,$4,ARRAY['read:reports'],'synthetic-private-access-hash','synthetic-private-access-prefix',now()-interval '1 day',$1::text,'synthetic-private-refresh-prefix',now()+interval '1 day')",[id,app,user.id,user.companyId]);
},30000);
afterAll(async()=>{const results=await Promise.allSettled([f?.close(),closeAccessReviewPool(),getAuthPool().end()]);const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'Access review fixture cleanup failed');});
it('includes another person’s OAuth grant hidden by owner RLS with exact owned census and no secrets',async()=>{
 const hidden=await f.actor(ctx=>ctx.sql`SELECT id FROM oauth_authorisations WHERE company_id=${f.f.companyA}::uuid`);expect(hidden).toEqual([]);
 const result=await f.actor(ctx=>reviewAccessControl(ctx,{kind:'oauth',limit:1}));
 expect(result.populationTotal).toBe(1);expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({id:ownGrant,personId:f.f.u2.id,permissions:[],refreshEligible:true});expect(result.nextCursor).toBeNull();
 const text=JSON.stringify(result);expect(text).not.toContain(foreignGrant);expect(text).not.toMatch(/synthetic-private|token_hash|token_prefix|last_used_ip/);
});
it('paginates the independent PAT census and refuses foreign cursor and current permission loss',async()=>{
 const expected=Number((await f.pool.query('SELECT count(*) FROM personal_access_tokens WHERE company_id=$1',[f.f.companyA])).rows[0].count);
 const ids:string[]=[];let cursor:string|null=null;
 do{const page=await f.actor(ctx=>reviewAccessControl(ctx,{kind:'pat',limit:1,...cursor?{cursor}:{}}));expect(page.populationTotal).toBe(expected);ids.push(...page.items.map(row=>row.id));cursor=page.nextCursor;}while(cursor);
 expect(new Set(ids).size).toBe(expected);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'access',false)",[f.f.companyA,f.f.u1.id]);
 try{await expect(f.actor(ctx=>reviewAccessControl(ctx,{kind:'pat'}))).rejects.toThrow('Current permissions');}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='access'",[f.f.companyA,f.f.u1.id]);}
 await expect(f.actor(ctx=>reviewAccessControl(ctx,{kind:'pat'}),'u1',0)).rejects.toThrow('Current permissions');
});
it('retains grants whose membership disappeared and distinguishes active profile from membership absence',async()=>{
 const role=(await f.pool.query('SELECT role FROM company_users WHERE company_id=$1 AND user_id=$2',[f.f.companyA,f.f.u2.id])).rows[0].role;
 await f.pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[f.f.companyA,f.f.u2.id]);
 try{const result=await f.actor(ctx=>reviewAccessControl(ctx,{kind:'oauth'}));expect(result.populationTotal).toBe(1);expect(result.items[0]?.standingReasons).toContain('membership_missing');expect(result.items[0]?.standingReasons).not.toContain('profile_missing');expect(result.items[0]?.refreshEligible).toBe(false);}
 finally{await f.pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)',[f.f.companyA,f.f.u2.id,role]);}
});
it('fails closed if the private login would be subject to owner-only RLS',async()=>{
 const clients=await Promise.all([getAccessReviewPool().connect(),getAccessReviewPool().connect()]);
 for(const client of clients){await client.query('SET ROLE app_user');client.release();}
 try{await expect(f.actor(ctx=>reviewAccessControl(ctx,{kind:'oauth'}))).rejects.toThrow(/row-level security/);}
 finally{const reset=await Promise.all([getAccessReviewPool().connect(),getAccessReviewPool().connect()]);for(const client of reset){await client.query('RESET ROLE');client.release();}}
});
it('serves concurrent reviews while every request-auth-pool connection is occupied',async()=>{
 const held=await Promise.all([getAuthPool().connect(),getAuthPool().connect()]);expect(getAuthPool().idleCount).toBe(0);expect(getAuthPool().totalCount).toBe(2);
 try{const results=await Promise.all(Array.from({length:4},()=>f.actor(ctx=>reviewAccessControl(ctx,{kind:'membership',limit:1}))));expect(results).toHaveLength(4);for(const result of results)expect(result.populationTotal).toBeGreaterThan(0);}
 finally{for(const client of held)client.release();}
},15000);
