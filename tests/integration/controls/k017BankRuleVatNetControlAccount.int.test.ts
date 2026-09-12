/**
 * K-017 — the bank-rule sweep reproduces K-016's net/gross split with no
 * human in the loop. The sweep's own line builder debited Accounts Payable
 * with the NET of a supplier rule carrying vat_code='standard' while the bank
 * leg and the supplier payment document carried the gross.
 *
 * The sweep now posts through the controlled bank allocation, whose party
 * plan carries no VAT code at all: the control account moves gross, and no
 * input tax is claimed on settling a bill that already claimed it. Two
 * matching statement lines, one sweep, driven through the real entry point
 * `applyRules` under the same control request a route would hold.
 */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {applyRules} from '@/modules/accounting/services/bank/bankRulesMatchingService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
let fixture:ForensicFixture;let supplier:string;
const bank=randomUUID(),ap=randomUUID(),vatInput=randomUUID(),tag=`K017 ${randomUUID()}`;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 for(const [id,type,subtype] of [[bank,'asset','bank'],[ap,'liability','payable'],[vatInput,'asset','vat_input'],[randomUUID(),'liability','vat_output']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,20),$3,$4,$3,$5,true,true)",[id,fixture.companyA,subtype,type,type==='asset'?'debit':'credit']);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'K017 bank',$2,'ZAR')",[fixture.companyA,bank]);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'K017 Jun 2026',6,2026,'2026-06-01','2026-06-30','open')",[randomUUID(),fixture.companyA]);
 supplier=(await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person))).supplier;
 for(const n of [1,2])await pool.query("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,'2026-06-30',-115,$3,'imported')",[fixture.companyA,bank,`ACME PAYMENT ${tag} ${n}`]);
 await pool.query("INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,supplier_id,vat_code,auto_create_entry,is_active,priority) VALUES($1,$2,'description','contains',$3,$4,'standard',true,true,1)",[fixture.companyA,`ACME rule ${tag}`,`ACME PAYMENT ${tag}`,supplier]);
});
afterAll(()=>pool.end());
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},fn);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function leg(accountId:string){
 const {rows}=await pool.query('SELECT COALESCE(SUM(debit),0)::float8 AS dr,COALESCE(SUM(credit),0)::float8 AS cr FROM gl_journal_lines WHERE company_id=$1 AND gl_account_id=$2',[fixture.companyA,accountId]);
 return rows[0] as {dr:number;cr:number};
}
it('relieves the payable by what the sweep actually paid, on every line, through the controlled allocation',async()=>{
 const result=await actor(()=>applyRules(fixture.companyA,bank,fixture.u1.id));
 expect(result.entries).toHaveLength(2);expect(result.autoPostSkippedApprovalRequired).toBe(0);
 // R230 of cash left the bank on two lines.
 expect((await leg(bank)).cr).toBeCloseTo(230,2);
 // The payment documents the controlled allocation created settle the gross.
 const {rows:[doc]}=await pool.query('SELECT COALESCE(SUM(total_amount),0)::float8 AS paid,COUNT(*)::int AS n FROM supplier_payments WHERE company_id=$1 AND supplier_id=$2',[fixture.companyA,supplier]);
 expect(doc).toEqual({paid:230,n:2});
 // THE CLAIM: the control account moves by the same R230, and no input tax is
 // claimable on settling a bill that already claimed it.
 expect((await leg(ap)).dr).toBeCloseTo(230,2);
 expect((await leg(vatInput)).dr).toBeCloseTo(0,2);
 // Each line has its receipt, under the same operation the screen would write.
 const {rows:effects}=await pool.query("SELECT e.result->>'journalEntryId' AS journal FROM control_operation_effects e JOIN control_bank_allocation_intents i ON i.company_id=e.company_id AND i.id::text=e.entity_id_canonical WHERE e.company_id=$1 AND e.operation='bank_allocation.post' AND i.bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2)",[fixture.companyA,bank]);
 expect(effects.map(r=>r.journal).sort()).toEqual(result.entries.map(e=>e.journalEntryId).sort());
},60000);
