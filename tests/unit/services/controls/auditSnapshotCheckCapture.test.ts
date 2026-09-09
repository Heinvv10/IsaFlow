import {expect,it} from 'vitest';
import {collectSnapshotCheckPages} from '@/modules/accounting/services/controls/auditSnapshotCheckCapture';
import type {ControlCheckResult} from '@/modules/accounting/services/controls/contracts';
const result:ControlCheckResult={checkId:'journal_risk_checks',checkVersion:1,status:'fail',populationCount:150,excludedCount:0,findingCount:2,
 amountTotals:{ZAR:'300'},findings:[],nextCursor:null,coverage:['owned'],missingSources:[],capturedAt:'2026-09-09T10:00:00.000Z',cutoff:'2026-09-09',sourceVersions:[]};
const finding=(key:string)=>({key,kind:'backdated',severity:'medium' as const,classification:'candidate' as const,entities:[],message:'Synthetic',evidence:[]});
it('retains all finding pages once and complete population totals',async()=>{
 const full=await collectSnapshotCheckPages(async cursor=>({...result,findings:[finding(cursor?'second':'first')],nextCursor:cursor?null:'next'}),()=>undefined);
 expect(full.findings.map(f=>f.key)).toEqual(['first','second']);expect(full.findingCount).toBe(2);expect(full.amountTotals).toEqual({ZAR:'300'});expect(full.nextCursor).toBeNull();
});
it('refuses mixed source versions even when findings and counts look stable',async()=>{
 await expect(collectSnapshotCheckPages(async cursor=>({...result,findings:[finding(cursor?'second':'first')],nextCursor:cursor?null:'next',
  sourceVersions:[{entityType:'journal_entry',entityId:'owned',version:cursor?2:1,fingerprint:'a'.repeat(64)}]}),()=>undefined)).rejects.toThrow(/changed/i);
});
it('refuses truncated or repeating finding pages',async()=>{
 await expect(collectSnapshotCheckPages(async()=>({...result,findings:[finding('one')]}),()=>undefined)).rejects.toThrow(/incomplete/i);
 await expect(collectSnapshotCheckPages(async()=>({...result,findings:[finding('one')],nextCursor:'repeat'}),()=>undefined)).rejects.toThrow(/repeat|duplicate/i);
});
it('awaits the transaction deadline guard before starting a check page',async()=>{
 let deadlineSet=false;
 const full=await collectSnapshotCheckPages(async()=>{
  if(!deadlineSet)throw new Error('Source query started before deadline was set');
  return{...result,findingCount:0,findings:[]};
 },async()=>{await Promise.resolve();deadlineSet=true;});
 expect(full.findingCount).toBe(0);
});
