import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {createRule,updateRule,getRules,applyRules} from '@/modules/accounting/services/bank/bankRulesService';
import {getBankTransactions} from '@/modules/accounting/services/bank/bankTransactionQueryService';
import type {BankCategorisationRule,RuleCreateInput} from '@/modules/accounting/types/bank.types';
type Ref='glAccountId'|'supplierId'|'clientId';
let f:Awaited<ReturnType<typeof transferControlFixture>>,owned:Record<Ref,string>,foreign:Record<Ref,string>;
beforeAll(async()=>{
 f=await transferControlFixture();owned={glAccountId:f.from,supplierId:randomUUID(),clientId:randomUUID()};foreign={glAccountId:randomUUID(),supplierId:randomUUID(),clientId:randomUUID()};
 await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$2,left($1::uuid::text,12),'Foreign synthetic GL','expense','debit',3)",[foreign.glAccountId,f.f.companyB]);
 for(const [company,refs,label] of [[f.f.companyA,owned,'Owned'],[f.f.companyB,foreign,'Foreign']] as const){
  await f.pool.query('INSERT INTO suppliers(id,company_id,name,company_name) VALUES($1,$2,$3,$3)',[refs.supplierId,company,`${label} synthetic supplier`]);
  await f.pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[refs.clientId,company,`${label} synthetic customer`]);
 }
},30000);afterAll(async()=>{if(f)await f.close();});
const input=(ref:Ref,id:string):RuleCreateInput=>({ruleName:'Synthetic reference rule',matchField:'description',matchType:'contains',matchPattern:`REF_${randomUUID()}`,[ref]:id,autoCreateEntry:false});
const counts=async()=> (await f.pool.query("SELECT (SELECT count(*)::int FROM bank_categorisation_rules WHERE company_id=$1) AS rules,(SELECT count(*)::int FROM control_change_events WHERE company_id=$1 AND entity_type='bank_categorisation_rule') AS events",[f.f.companyA])).rows[0];
for(const ref of ['glAccountId','supplierId','clientId'] as const)it(`accepts and captures the actual owned ${ref} without changing defaults`,async()=>{
 const created=await f.actor(()=>createRule(f.f.companyA,input(ref,owned[ref]),f.f.u1.id));expect(created[ref]).toBe(owned[ref]);expect(created.autoCreateEntry).toBe(false);
 const updated=await f.actor(()=>updateRule(f.f.companyA,created.id,{[ref]:owned[ref],priority:0}));expect(updated[ref]).toBe(owned[ref]);expect(updated.priority).toBe(0);
});
for(const mode of ['create','update'] as const)for(const ref of ['glAccountId','supplierId','clientId'] as const)it(`${mode} refuses foreign ${ref} before history or downstream suggestion exposure`,async()=>{
 const value=input(ref,foreign[ref]),original=mode==='update'?await f.actor(()=>createRule(f.f.companyA,{...value,[ref]:owned[ref]},f.f.u1.id)):null;
 const before=await counts();let accepted:BankCategorisationRule|undefined,failure:unknown;
 try{accepted=await f.actor(()=>mode==='create'?createRule(f.f.companyA,value,f.f.u1.id):updateRule(f.f.companyA,original!.id,{[ref]:foreign[ref]}));}catch(error){failure=error;}
 let downstream:unknown=null;
 if(accepted){
  const bank=await f.bank();await f.pool.query('UPDATE bank_transactions SET description=$3 WHERE company_id=$1 AND id=$2',[f.f.companyA,bank,value.matchPattern]);
  downstream=await f.actor(async()=>{
   const listed=(await getRules(f.f.companyA)).find(rule=>rule.id===accepted!.id);
   const applied=await applyRules(f.f.companyA,f.from,f.f.u1.id,[accepted!.id]);
   const displayed=(await getBankTransactions(f.f.companyA,{bankAccountId:f.from,search:value.matchPattern})).transactions.find(tx=>tx.id===bank);
   return{ruleReference:listed?.[ref],ruleClientName:listed?.clientName,applied:applied.applied,
    suggestedClientId:displayed?.suggestedClientId,suggestedClientName:displayed?.suggestedClientName};
  });
 }
 expect(failure,JSON.stringify({mode,ref,acceptedId:accepted?.id,downstream})).toBeDefined();expect(await counts()).toEqual(before);
 if(original)expect((await f.actor(()=>getRules(f.f.companyA))).find(rule=>rule.id===original.id)?.[ref]).toBe(owned[ref]);
});
