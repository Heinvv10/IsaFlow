/**
 * Adapter identity checks stay unit-level. Financial coverage moved to actual PostgreSQL
 * legacyVoidControls.int.test.ts: approved AR/AP effects, rollback, retained allocations,
 * current permissions and the exact approved bank inverse. No fake control-boundary mocks.
 */
import {describe,it,expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als} from '@/lib/als';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {isVoidRefusal,voidPaymentDocument} from '@/modules/accounting/services/core/paymentVoidService';
const company='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222',payment='33333333-3333-4333-8333-333333333333';
describe('voidPaymentDocument issued identity boundary',()=>{
 it('refuses before lookup without a request context',async()=>{
  await expect(voidPaymentDocument(company,'customer',payment,person)).rejects.toThrow('Authenticated control transaction required');
 });
 it('does not treat an ALS-shaped context as issued authority',async()=>{
  const query=vi.fn(),client={query} as unknown as PoolClient;
  await expect(als.run({client,userId:person,companyId:company,claims:{}},()=>voidPaymentDocument(company,'supplier',payment,person))).rejects.toThrow('Authenticated control transaction required');
  expect(query).not.toHaveBeenCalled();
 });
 for(const mismatch of ['company','person'] as const)it(`refuses mismatched ${mismatch} before any query`,async()=>{
  const query=vi.fn(),client={query} as unknown as PoolClient;
  await expect(withControlRequest({client,userId:person,companyId:company,claims:{}},{personId:person,companyId:company,authMethod:'cookie'},
   ()=>voidPaymentDocument(mismatch==='company'?payment:company,'customer',payment,mismatch==='person'?payment:person)))
   .rejects.toThrow('Control transaction actor does not match payment void');
  expect(query).not.toHaveBeenCalled();
 });
 for(const refusal of ['not_found','already_cancelled','not_applied','ambiguous_bank_lines'] as const)it(`recognizes ${refusal} without representing it as an effect`,()=>{
  expect(isVoidRefusal({refusal,count:2,status:'draft'})).toBe(true);
 });
 it('recognizes an actual result shape separately from refusal',()=>{
  expect(isVoidRefusal({paymentId:payment,paymentNumber:null,kind:'customer',invoicesReopened:0,amountUnapplied:0,journalEntryId:null,bankTransactionId:null})).toBe(false);
 });
});
