import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankRuleChangeHttpFixture} from './bankRuleChangeHttpFixture';
let f:Awaited<ReturnType<typeof bankRuleChangeHttpFixture>>;
beforeAll(async()=>{f=await bankRuleChangeHttpFixture();},30000);afterAll(async()=>{if(f)await f.close();});
it('existing default MCP CRUD traverses central capture and records actual PAT provenance',async()=>{
 const rule=await f.call<{id:string}>('create_bank_rule',{rule_name:'Actual MCP rule',match_field:'description',match_type:'contains',match_pattern:'MCP_RULE',gl_account_id:f.from,idempotency_key:randomUUID()});
 await f.call('update_bank_rule',{rule_id:rule.id,priority:0,idempotency_key:randomUUID()});
 await f.call('disable_bank_rule',{rule_id:rule.id,idempotency_key:randomUUID()});
 const events=(await f.pool.query("SELECT new_version,action,person_id,connection_id FROM control_change_events WHERE company_id=$1 AND entity_type='bank_categorisation_rule' AND entity_id=$2 ORDER BY new_version",[f.f.companyA,rule.id])).rows;
 expect(events.map(row=>row.new_version)).toEqual([1,2,3]);expect(events.map(row=>row.action)).toEqual(['bank_categorisation_rule.created','bank_categorisation_rule.updated','bank_categorisation_rule.toggled']);
 for(const event of events)expect(event).toMatchObject({person_id:f.f.u1.id,connection_id:f.f.u1.tokens[0]!.id});
});
it('real cookie seed captures every created rule and rolls back the whole batch on evidence failure',async()=>{
 const code=(await f.pool.query('SELECT account_code FROM gl_accounts WHERE company_id=$1 AND id=$2',[f.f.companyA,f.from])).rows[0].account_code;
 const response=await f.request([{originalCategory:'Rule Seed First',standardCategory:'First',glCode:code},{originalCategory:'Missing account',glCode:'missing'}]);
 expect(response.status).toBe(200);expect(response.body.data).toMatchObject({created:1,skipped:1,missingGlCodes:['missing']});
 const count=async()=> (await f.pool.query("SELECT (SELECT count(*)::int FROM bank_categorisation_rules WHERE company_id=$1) AS rules,(SELECT count(*)::int FROM control_change_events WHERE company_id=$1 AND entity_type='bank_categorisation_rule') AS events",[f.f.companyA])).rows[0];
 const before=await count();expect(before.rules).toBe(2);expect(before.events).toBe(4);
 const name=`seed_evidence_${randomUUID().replaceAll('-','')}`;
 await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.entity_type='bank_categorisation_rule' AND (SELECT count(*) FROM bank_categorisation_rules WHERE company_id=NEW.company_id AND match_pattern LIKE 'atomic seed %')=2 THEN RAISE EXCEPTION 'Synthetic seed evidence refusal'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON control_protected_evidence FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  const failed=await f.request([{originalCategory:'Atomic Seed One',glCode:code},{originalCategory:'Atomic Seed Two',glCode:code}]);expect(failed.status).toBeGreaterThanOrEqual(400);
  expect(await count()).toEqual(before);
 }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_protected_evidence`);await f.pool.query(`DROP FUNCTION ${name}()`);}
});
