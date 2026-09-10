import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
import {executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {executePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
import {committed,runLegacySeed,useSeedKeys,type Baseline,type LegacyOp,type LegacySeed} from './intentReceiptLegacyHarness';
import {actorAs,effectRows,insertCaseVariantReceipt,ledgerRows,receiptsFor} from './intentReceiptRows';
const pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,ssl:false,max:3,statement_timeout:10000});
const seeds={} as Record<Baseline,LegacySeed>;
beforeAll(async()=>{seeds.upper=await runLegacySeed('upper');seeds.window=await runLegacySeed('window');},700000);
afterAll(async()=>{await pool.end();});
const operationOf:Record<LegacyOp,string>={bank:'bank_allocation.post',bankOriginal:'bank_allocation.post',bankReversal:'bank_allocation.reverse',
 cash:'cash_application.apply',cashReversal:'cash_application.reverse',compensation:'payroll_compensation.change'};
const approval=(id?:string)=>id?{approvalId:id}:undefined;
const executeOf:Record<LegacyOp,(ctx:ControlTx,id:string,approvalId?:string)=>Promise<unknown>>={
 bank:(ctx,id,a)=>executeBankAllocation(ctx,id,approval(a)),bankOriginal:(ctx,id,a)=>executeBankAllocation(ctx,id,approval(a)),
 bankReversal:(ctx,id,a)=>executeBankAllocationReversal(ctx,id,approval(a)),cash:(ctx,id,a)=>executeCashApplication(ctx,id,approval(a)),
 cashReversal:(ctx,id,a)=>executeCashApplicationReversal(ctx,id,approval(a)),compensation:(ctx,id,a)=>executePayrollCompensation(ctx,id,approval(a)??{}),
};
// Traced from source: a legacy run succeeds only when its own post-effect re-materialization agrees with
// the receipt it just wrote; every other uppercase-first run rolled back and left no receipt at all.
const traced:Record<Baseline,Record<LegacyOp,boolean>>={
 upper:{bank:true,bankOriginal:true,bankReversal:true,cash:false,cashReversal:false,compensation:true},
 window:{bank:false,bankOriginal:false,bankReversal:true,cash:true,cashReversal:false,compensation:false},
};
async function snapshot(seed:LegacySeed){return{effects:await effectRows(pool,seed.fixture.companyA),ledger:await ledgerRows(pool,seed.fixture.companyA)};}
it('baseline worktrees wrote exactly the traced legacy receipt population and spellings',async()=>{
 for(const kind of ['upper','window'] as const){
  const seed=seeds[kind];
  const refusals=Object.entries(seed.ops).map(([op,o])=>o.ok?'':`${op}: ${o.error}`).filter(Boolean).join('; ');
  expect({kind,ok:Object.fromEntries(Object.entries(seed.ops).map(([op,o])=>[op,o.ok]))},`${kind} baseline refusals: ${refusals}`).toEqual({kind,ok:traced[kind]});
  for(const [op,outcome] of Object.entries(seed.ops) as [LegacyOp,LegacySeed['ops'][LegacyOp]][]){
   const rows=await receiptsFor(pool,seed.fixture.companyA,outcome.intentId,operationOf[op]);
   expect(rows,`${kind} ${op}`).toHaveLength(outcome.ok?1:0);
   if(outcome.ok)expect(rows[0]!.entity_id,`${kind} ${op}`).toBe(kind==='upper'?outcome.intentId.toUpperCase():outcome.intentId);
  }
 }
 expect(committed(seeds.upper,'bank').result.intentId).toBe(seeds.upper.ops.bank.intentId.toUpperCase());
 expect(committed(seeds.upper,'compensation').result.intentId).toBe(seeds.upper.ops.compensation.intentId.toUpperCase());
 // Second-window shape: lowercase entity_id with an uppercase result identity.
 expect(committed(seeds.window,'bankReversal').result.intentId).toBe(seeds.window.ops.bankReversal.intentId.toUpperCase());
});
async function replaysUnchangedThenRefusesTwin(kind:Baseline,op:LegacyOp,twinProbe?:()=>Promise<unknown>){
 const seed=seeds[kind],outcome=committed(seed,op),user=seed.fixture.u1;useSeedKeys(seed);
 const before=await snapshot(seed);
 for(const [id,approvalId] of [[outcome.intentId,undefined],[outcome.intentId.toUpperCase(),undefined],[outcome.intentId,outcome.approvalId],[outcome.intentId.toUpperCase(),outcome.approvalId]] as const)
  expect(await actorAs(pool,user,ctx=>executeOf[op](ctx,id,approvalId)),`${kind} ${op} ${id} ${approvalId??'no approval'}`).toEqual(outcome.result);
 expect(await snapshot(seed)).toEqual(before);
 const [receipt]=await receiptsFor(pool,seed.fixture.companyA,outcome.intentId,operationOf[op]);
 const twin=await insertCaseVariantReceipt(pool,user,receipt!.id),withTwin=await snapshot(seed);
 for(const id of [outcome.intentId,outcome.intentId.toUpperCase()])await expect(actorAs(pool,user,ctx=>executeOf[op](ctx,id))).rejects.toThrow('Ambiguous operation receipt');
 if(twinProbe)await expect(twinProbe()).rejects.toThrow('Ambiguous operation receipt');
 expect(await snapshot(seed)).toEqual(withTwin);
 expect(withTwin.effects).toHaveLength(before.effects.length+1);
 expect(twin.entity_id).not.toBe(receipt!.entity_id);
}
for(const [kind,op] of [['upper','bank'],['upper','bankReversal'],['upper','compensation'],['window','bankReversal']] as const)
 it(`${kind} baseline ${op} receipt replays unchanged for both spellings; a case-variant twin is refused`,()=>replaysUnchangedThenRefusesTwin(kind,op),60000);
it('window baseline cash receipt replays unchanged; its twin is refused for replay and as a reversal original',async()=>{
 const seed=seeds.window,original=committed(seed,'cash').intentId;
 await replaysUnchangedThenRefusesTwin('window','cash',()=>actorAs(pool,seed.fixture.u1,ctx=>prepareCashApplicationReversal(ctx,{originalIntentId:original,reversalDate:'2026-09-11',reason:'Synthetic twin original'})));
},60000);
async function approve(seed:LegacySeed,ref:OperationRef){
 const request=await actorAs(pool,seed.fixture.u1,ctx=>requestOperationApproval(ctx,ref));
 await actorAs(pool,seed.fixture.u2,ctx=>decideOperationApproval(ctx,request.id,'approved'));
 return request.id;
}
it('upper baseline allocation is reversible at HEAD without rewriting its receipt; a twin original is then refused',async()=>{
 const seed=seeds.upper,outcome=committed(seed,'bankOriginal'),user=seed.fixture.u1,company=seed.fixture.companyA;useSeedKeys(seed);
 const originals=await receiptsFor(pool,company,outcome.intentId,'bank_allocation.post');
 const prepared=await actorAs(pool,user,ctx=>prepareBankAllocationReversal(ctx,{originalIntentId:outcome.intentId,reversalDate:'2026-09-11',reason:'Synthetic HEAD inverse of legacy receipt'}));
 const approvalId=await approve(seed,prepared.operation);
 const reversal=await actorAs(pool,user,ctx=>executeBankAllocationReversal(ctx,prepared.intentId,{approvalId}));
 expect(await receiptsFor(pool,company,outcome.intentId,'bank_allocation.post')).toEqual(originals);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[company,outcome.result.journalEntryId])).rows).toHaveLength(1);
 expect(await actorAs(pool,user,ctx=>executeBankAllocationReversal(ctx,prepared.intentId.toUpperCase()))).toEqual(reversal);
 await insertCaseVariantReceipt(pool,user,originals[0]!.id);
 const withTwin=await snapshot(seed);
 await expect(actorAs(pool,user,ctx=>executeBankAllocationReversal(ctx,prepared.intentId))).rejects.toThrow('Ambiguous operation receipt');
 expect(await snapshot(seed)).toEqual(withTwin);
},60000);
