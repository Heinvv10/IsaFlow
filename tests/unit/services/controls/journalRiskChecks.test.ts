import {expect,it} from 'vitest';
import {analyseJournalRisks,type JournalRiskRow} from '@/modules/accounting/services/controls/journalRiskAnalysis';
const row=(id='a'):JournalRiskRow=>({id,accountingDate:'2026-09-09',actualAt:'2026-09-09T10:00:00Z',actualBasis:'posted_at',personId:'p',amount:'6000',currency:'ZAR',reversalOfId:null,reversedAt:null,periodState:null,periodEventId:null,version:null});
it('uses actual SAST time while keeping a backdated accrual an investigation lead',()=>{
 const result=analyseJournalRisks([{...row(),accountingDate:'2026-08-31',actualAt:'2026-09-09T20:00:00Z'}],[]);
 expect(result[0]?.reasons).toEqual(expect.arrayContaining(['backdated_accounting_date','outside_business_hours']));
 expect(result[0]?.classification).toBe('candidate');
 expect(analyseJournalRisks([{...row(),actualAt:'2026-09-08T22:30:00Z'}],[])[0]?.reasons).not.toContain('backdated_accounting_date');
});
it('groups exact current-threshold exposure without counting journal lines or currencies together',()=>{
 const policy={id:'policy',version:1,amount:'10000',operator:'greater_than' as const};
 expect(analyseJournalRisks([row('a'),row('b')],[policy]).map(r=>r.reasons)).toEqual([['possible_threshold_split:policy:v1'],['possible_threshold_split:policy:v1']]);
 expect(analyseJournalRisks([row()],[policy])).toEqual([]);
 expect(analyseJournalRisks([row(),{...row('b'),currency:'USD'}],[policy])).toEqual([]);
});
it('keeps reversals explicit and only flags closed-state chronology supplied by actual preceding event',()=>{
 expect(analyseJournalRisks([{...row(),reversalOfId:'original',periodState:'closed',periodEventId:'event'}],[])[0]?.reasons)
 .toEqual(expect.arrayContaining(['reversal_relation','write_after_recorded_period_close']));
 expect(analyseJournalRisks([{...row(),periodState:'open',periodEventId:'reopened'}],[])).toEqual([]);
});
