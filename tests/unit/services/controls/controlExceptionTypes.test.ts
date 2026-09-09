import {describe,it,expect} from 'vitest';
import type {ControlCheckResult} from '@/modules/accounting/services/controls/contracts';
import {canFixException,exceptionCheckSummary,parseExceptionCheck,parseExceptionResolution} from '@/modules/accounting/services/controls/controlExceptionTypes';
const pass:ControlCheckResult={checkId:'three_way_match_exceptions',checkVersion:1,status:'pass',populationCount:1,excludedCount:0,
 findingCount:0,amountTotals:{},findings:[],nextCursor:null,coverage:['complete'],missingSources:[],capturedAt:new Date().toISOString(),cutoff:null,sourceVersions:[]};
describe('server recheck closure gate',()=>{
 it('permits a complete current-rule pass',()=>expect(canFixException(pass,pass.checkId,1)).toBe(true));
 it.each(['fail','unknown','error'] as const)('refuses %s even when the target disappeared',status=>expect(canFixException({...pass,status},pass.checkId,1)).toBe(false));
 it.each([{nextCursor:'next'},{findingCount:1},{missingSources:['missing']},{checkVersion:0},{checkVersion:2},{checkId:'other'}])('refuses incomplete or changed-rule material %j',change=>{
  expect(canFixException({...pass,...change},pass.checkId,1)).toBe(false);
 });
 it('does not trust zero count if a finding body remains',()=>expect(canFixException({...pass,findings:[{key:'x',kind:'x',severity:'high',classification:'confirmed',entities:[],evidence:[],message:'x'}]},pass.checkId,1)).toBe(false));
});
describe('bounded exception inputs',()=>{
 it('allows only supported checks and bounded options',()=>{
  expect(parseExceptionCheck({checkId:'three_way_match_exceptions',cutoff:'2026-09-09'})).toEqual({checkId:'three_way_match_exceptions',cutoff:'2026-09-09'});
  for(const value of [{checkId:'payroll_control_checks'},{checkId:'three_way_match_exceptions',result:pass},{checkId:'three_way_match_exceptions',cutoff:'2026-02-31'}])expect(()=>parseExceptionCheck(value)).toThrow();
 });
 it('requires accepted risk reason and future expiry and rejects caller recheck results',()=>{
  const input={exceptionId:'ad27508a-1f27-4ed3-9ad3-a5e14a47a6ba',expectedVersion:1,resolution:'accepted_risk',reason:'Documented decision',expiresAt:'2099-01-01T00:00:00Z'};
  expect(parseExceptionResolution(input).reason).toBe(input.reason);
  for(const change of [{reason:''},{expiresAt:'2000-01-01T00:00:00Z'},{expiresAt:'2099-02-31T00:00:00Z'},{expectedVersion:0},{result:pass}])expect(()=>parseExceptionResolution({...input,...change})).toThrow();
 });
});
it('rejects resolution accessors without invoking them, including expiry-bypass getters',()=>{
 let reads=0;const input={exceptionId:'ad27508a-1f27-4ed3-9ad3-a5e14a47a6ba',expectedVersion:1,reason:'Review',expiresAt:'2000-01-01T00:00:00Z',
 get resolution(){return ++reads===2?'fixed':'accepted_risk';}};
 expect(()=>parseExceptionResolution(input)).toThrow();expect(reads).toBe(0);
});
it('rejects check accessors without invoking them',()=>{
 let reads=0;expect(()=>parseExceptionCheck({get checkId(){reads++;return 'three_way_match_exceptions';}})).toThrow();expect(reads).toBe(0);
});

it('refuses retention overflow instead of discarding recheck source fingerprints',()=>{
 const result={...pass,sourceVersions:Array.from({length:10000},(_,index)=>({entityType:'supplier_invoice',entityId:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,version:1,fingerprint:'a'.repeat(64)}))};
 expect(()=>exceptionCheckSummary(result)).toThrow(/asynchronous retained evidence/);
});
