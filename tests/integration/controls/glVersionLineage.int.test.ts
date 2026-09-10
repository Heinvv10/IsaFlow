import {expect,it} from 'vitest';
import {actor,glFixture,legacy,pool} from './glAccountChangeFixture';
import {updateAccount} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {appendEntityVersion,entityVersions} from './intentReceiptRows';
const byId=(rows:{entity_id:string;version:number}[])=>[...rows].sort((a,b)=>a.entity_id<b.entity_id?-1:1);
it('a GL account change extends the lineage retained only under a legacy spelling',async()=>{
 const f=glFixture(),id=await legacy();
 await appendEntityVersion(pool,{id:f.u1.id,companyId:f.companyA},'gl_account',id.toUpperCase());
 await actor(()=>updateAccount(f.companyA,id,{accountName:'Legacy lineage rename'}));
 expect(await entityVersions(pool,f.companyA,'gl_account',id)).toEqual([{entity_id:id.toUpperCase(),version:2}]);
});
it('a GL account change on a forked account reads and extends its most advanced lineage',async()=>{
 const f=glFixture(),id=await legacy();
 await appendEntityVersion(pool,{id:f.u1.id,companyId:f.companyA},'gl_account',id,1);
 await appendEntityVersion(pool,{id:f.u1.id,companyId:f.companyA},'gl_account',id.toUpperCase(),4);
 await actor(()=>updateAccount(f.companyA,id,{accountName:'Forked lineage rename'}));
 expect(byId(await entityVersions(pool,f.companyA,'gl_account',id))).toEqual(byId([{entity_id:id,version:1},{entity_id:id.toUpperCase(),version:5}]));
});
