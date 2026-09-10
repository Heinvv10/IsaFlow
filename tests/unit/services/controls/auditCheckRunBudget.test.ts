import {expect,it,vi} from 'vitest';
import {auditCheckRunBudget} from '@/modules/accounting/services/controls/auditCheckRunBudget';
import {AUDIT_CHECK_RUN_LIMITS} from '@/modules/accounting/services/controls/auditCheckRunContract';
it('carries the whole check-run budget instead of the sixty-second snapshot index ceiling',()=>{
 const now=Date.now();vi.useFakeTimers();vi.setSystemTime(now);
 try{
  const check=auditCheckRunBudget({deadlineAt:now+AUDIT_CHECK_RUN_LIMITS.journal_risk_checks.maxRuntimeMs});
  vi.setSystemTime(now+120000);expect(()=>check()).not.toThrow();
  vi.setSystemTime(now+AUDIT_CHECK_RUN_LIMITS.journal_risk_checks.maxRuntimeMs+1);expect(()=>check()).toThrow(/deadline/i);
 }finally{vi.useRealTimers();}
});
it('refuses a missing deadline, a foreign option and a non-signal, and aborts on the caller signal',()=>{
 expect(()=>auditCheckRunBudget({} as never)).toThrow(/deadline/i);
 expect(()=>auditCheckRunBudget({deadlineAt:Date.now()+1000,other:1} as never)).toThrow(/options/i);
 expect(()=>auditCheckRunBudget({deadlineAt:Date.now()+1000,signal:{aborted:false} as never})).toThrow(/signal/i);
 const controller=new AbortController(),check=auditCheckRunBudget({deadlineAt:Date.now()+1000,signal:controller.signal});
 expect(()=>check()).not.toThrow();controller.abort();expect(()=>check()).toThrow(/aborted/i);
});
it('reads the deadline through the property descriptor so a getter cannot widen it mid-run',()=>{
 const options={};Object.defineProperty(options,'deadlineAt',{get:()=>Date.now()+600000,enumerable:true});
 expect(()=>auditCheckRunBudget(options as never)).toThrow(/options/i);
});
