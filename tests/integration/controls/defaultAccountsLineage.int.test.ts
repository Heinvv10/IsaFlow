import {afterAll,beforeAll,expect,it} from 'vitest';
import {defaultAccountsFixture} from './defaultAccountsFixture';
import {appendEntityVersion,entityVersions} from './intentReceiptRows';
let f:Awaited<ReturnType<typeof defaultAccountsFixture>>;
beforeAll(async()=>{f=await defaultAccountsFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('saving default accounts extends a gl_account lineage retained under a legacy spelling instead of blocking forever',async()=>{
 const account=await f.account();
 await appendEntityVersion(f.pool,{id:f.f.u1.id,companyId:f.f.companyA},'gl_account',account.toUpperCase());
 const response=await f.rest('POST',{mappings:{accounts_receivable:account}});
 expect(response.status).toBe(200);
 expect(await entityVersions(f.pool,f.f.companyA,'gl_account',account)).toEqual([{entity_id:account.toUpperCase(),version:2}]);
});
