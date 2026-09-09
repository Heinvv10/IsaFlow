import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {createRule,updateRule,toggleRule,deleteRule,deleteRules} from '@/modules/accounting/services/bank/bankRulesService';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeAll(async()=>{f=await transferControlFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const input=()=>({ruleName:'Synthetic rule',matchField:'description' as const,matchType:'contains' as const,matchPattern:'SYNTHETIC',glAccountId:f.from,priority:0,autoCreateEntry:false});
const create=()=>f.actor(()=>createRule(f.f.companyA,input(),f.f.u1.id));
async function history(id:string){
 const rows=(await f.pool.query("SELECT e.*,p.key_id,p.envelope_version,p.ciphertext FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND p.entity_id=e.entity_id WHERE e.company_id=$1 AND e.entity_type='bank_categorisation_rule' AND e.entity_id=$2 ORDER BY e.new_version",[f.f.companyA,id])).rows;
 return rows.map(row=>({...row,new_version:Number(row.new_version),previous_version:row.previous_version===null?null:Number(row.previous_version),exact:openProtectedChange({version:row.envelope_version,keyId:row.key_id,ciphertext:row.ciphertext})}));
}
const row=async(id:string)=>(await f.pool.query('SELECT * FROM bank_categorisation_rules WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0];
it('captures exact create/update/toggle/delete versions and suppresses meaningful no-ops',async()=>{
 const rule=await create();expect(rule.priority).toBe(100);const original=await row(rule.id);
 let events=await history(rule.id);expect(events).toHaveLength(1);expect(events[0].exact).toEqual({before:null,after:JSON.parse(JSON.stringify(original))});
 expect(events[0]).toMatchObject({person_id:f.f.u1.id,previous_version:null,new_version:1,action:'bank_categorisation_rule.created'});
 const updated=await f.actor(()=>updateRule(f.f.companyA,rule.id,{ruleName:'Changed',priority:0,autoCreateEntry:false}));expect(updated.priority).toBe(0);
 await f.actor(()=>updateRule(f.f.companyA,rule.id,{ruleName:'Changed',priority:0}));
 await f.actor(()=>toggleRule(f.f.companyA,rule.id,false));await f.actor(()=>toggleRule(f.f.companyA,rule.id,false));
 const removed=await row(rule.id);await f.actor(()=>deleteRule(f.f.companyA,rule.id));events=await history(rule.id);
 expect(events.map(e=>e.new_version)).toEqual([1,2,3,4]);expect(events.map(e=>e.action)).toEqual(['bank_categorisation_rule.created','bank_categorisation_rule.updated','bank_categorisation_rule.toggled','bank_categorisation_rule.deleted']);
 expect(events[1].exact.before).toEqual(events[0].exact.after);expect(events[3].exact).toEqual({before:JSON.parse(JSON.stringify(removed)),after:null});expect(await row(rule.id)).toBeUndefined();
});
it('detaches caller values before awaiting and records actual second-person PAT attribution',async()=>{
 const value=input();const rule=await f.actor(async()=>{const pending=createRule(f.f.companyA,value,f.f.u1.id);value.ruleName='Mutated after call';return pending;});expect(rule.ruleName).toBe('Synthetic rule');
 await f.actor(()=>updateRule(f.f.companyA,rule.id,{matchPattern:'SECOND'}),'u2',0);
 const events=await history(rule.id);expect(events[1]).toMatchObject({person_id:f.f.u2.id,connection_id:f.f.u2.tokens[0]!.id,grant_id:f.f.u2.tokens[0]!.id});
 let invoked=0;const malicious=Object.defineProperty({...input()},'ruleName',{enumerable:true,get:()=>{invoked++;return 'Unsafe';}});
 await expect(f.actor(()=>createRule(f.f.companyA,malicious,f.f.u1.id))).rejects.toThrow();expect(invoked).toBe(0);
});
it('serializes concurrent updates into contiguous versions and bulk delete is distinct and complete',async()=>{
 const a=await create(),b=await create();await Promise.all([f.actor(()=>updateRule(f.f.companyA,a.id,{priority:1})),f.actor(()=>updateRule(f.f.companyA,a.id,{priority:2}))]);
 const events=await history(a.id);expect(events.map(e=>e.new_version)).toEqual([1,2,3]);expect(events[2].exact.before).toEqual(events[1].exact.after);
 expect(await f.actor(()=>deleteRules(f.f.companyA,[b.id,a.id,a.id]))).toBe(2);expect(await row(a.id)).toBeUndefined();expect(await row(b.id)).toBeUndefined();
 expect((await history(a.id)).at(-1)?.new_version).toBe(4);expect((await history(b.id)).at(-1)?.new_version).toBe(2);
});
it('refuses foreign/missing references, changed user assertions and revoked authority without a partial bulk mutation',async()=>{
 const rule=await create(),before=await row(rule.id),events=await history(rule.id);
 const foreign=randomUUID();await f.pool.query("INSERT INTO bank_categorisation_rules(id,company_id,rule_name,match_field,match_type,match_pattern,created_by) VALUES($1,$2,'Legacy foreign rule','description','contains','FOREIGN',$3)",[foreign,f.f.companyB,f.f.u3.id]);
 await expect(f.actor(()=>deleteRules(f.f.companyA,[rule.id,foreign]))).rejects.toThrow();
 expect((await f.pool.query('SELECT id FROM bank_categorisation_rules WHERE company_id=$1 AND id=$2',[f.f.companyB,foreign])).rows).toHaveLength(1);
 await expect(f.actor(()=>deleteRules(f.f.companyA,[rule.id,randomUUID()]))).rejects.toThrow();
 await expect(f.actor(()=>toggleRule(f.f.companyB,rule.id,false))).rejects.toThrow();
 await expect(f.actor(()=>createRule(f.f.companyA,input(),f.f.u2.id))).rejects.toThrow();
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[f.f.companyA,f.f.u1.id]);
 try{await expect(f.actor(()=>updateRule(f.f.companyA,rule.id,{ruleName:'Denied'}))).rejects.toThrow();}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.f.companyA,f.f.u1.id]);}
 expect(await row(rule.id)).toEqual(before);expect(await history(rule.id)).toEqual(events);
});
it('evidence insertion failure rolls back every bulk deletion and prior event/version in the savepoint',async()=>{
 const a=await create(),b=await create(),ids=[a.id,b.id].sort(),name=`rule_evidence_${randomUUID().replaceAll('-','')}`;
 const before=await Promise.all(ids.map(row)),events=await Promise.all(ids.map(history));
 await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.entity_type='bank_categorisation_rule' AND NEW.entity_id='${ids[1]}' THEN RAISE EXCEPTION 'Synthetic evidence refusal'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON control_protected_evidence FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  await expect(f.actor(()=>deleteRules(f.f.companyA,ids))).rejects.toThrow('Synthetic evidence refusal');
  expect(await Promise.all(ids.map(row))).toEqual(before);expect(await Promise.all(ids.map(history))).toEqual(events);
 }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_protected_evidence`);await f.pool.query(`DROP FUNCTION ${name}()`);}
});
it('a suppressed delete cannot produce false deleted history or a partial bulk result',async()=>{
 const a=await create(),b=await create(),ids=[a.id,b.id].sort(),name=`rule_suppress_${randomUUID().replaceAll('-','')}`;
 const before=await Promise.all(ids.map(row)),events=await Promise.all(ids.map(history));
 await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.company_id='${f.f.companyA}'::uuid AND OLD.id='${ids[1]}'::uuid THEN RETURN NULL; END IF; RETURN OLD; END $$`);
 try{
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE DELETE ON bank_categorisation_rules FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  let result:number|undefined,failure:unknown;
  try{result=await f.actor(()=>deleteRules(f.f.companyA,ids));}catch(error){failure=error;}
  const remaining=await Promise.all(ids.map(row)),afterEvents=await Promise.all(ids.map(history));
  expect(failure,{returned:result,remaining:remaining.filter(Boolean).length,versions:afterEvents.map(list=>list.length)}).toBeDefined();
  expect(remaining).toEqual(before);expect(afterEvents).toEqual(events);
 }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON bank_categorisation_rules`);await f.pool.query(`DROP FUNCTION ${name}()`);}
});
