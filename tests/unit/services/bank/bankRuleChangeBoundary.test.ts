import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({sql:vi.fn(async()=>[{id:'rule',rule_name:'Original',priority:100}])}));
vi.mock('@/lib/neon',()=>({sql:mock.sql,withSavepoint:async(_name:string,fn:()=>Promise<unknown>)=>fn()}));
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingService',()=>({applyRules:vi.fn()}));
import {createRule,updateRule,toggleRule,deleteRule,deleteRules} from '@/modules/accounting/services/bank/bankRulesService';
const company='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const input={ruleName:'Original',matchField:'description' as const,matchType:'contains' as const,matchPattern:'SYNTHETIC'};
beforeEach(()=>vi.clearAllMocks());
for(const [name,run] of [
 ['create',()=>createRule(company,input,'person')],['update',()=>updateRule(company,id,{ruleName:'Changed'})],
 ['toggle',()=>toggleRule(company,id,false)],['delete',()=>deleteRule(company,id)],['bulk',()=>deleteRules(company,[id])],['empty bulk',()=>deleteRules(company,[])],
] as const)it(`${name} requires a real issued control transaction before any rule SQL`,async()=>{
 await expect(run()).rejects.toThrow();expect(mock.sql).not.toHaveBeenCalled();
});
it('rejects caller property accessors without invoking them',async()=>{
 const getter=vi.fn(()=> 'Changed'),value=Object.defineProperty({...input},'ruleName',{enumerable:true,get:getter});
 await expect(createRule(company,value,'person')).rejects.toThrow();expect(getter).not.toHaveBeenCalled();expect(mock.sql).not.toHaveBeenCalled();
});
