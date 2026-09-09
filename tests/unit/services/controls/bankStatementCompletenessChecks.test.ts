import {expect,it} from 'vitest';
import {analyseBankStatementCompleteness,type StatementObservation} from '@/modules/accounting/services/controls/bankStatementCompletenessAnalysis';
const row=():StatementObservation=>({id:'statement',accountId:'bank',periodStart:'2026-08-01',periodEnd:'2026-08-31',sourceCount:10,opening:'1000',closing:'1500',importedCount:9,importedNet:'400',sourceBytesVerified:true});
it('compares independent source observations to imported counts and exact balances without claiming OCR confirmation',()=>{
 const result=analyseBankStatementCompleteness(row());
 expect(result.reasons).toEqual(['statement_count_difference','statement_balance_difference']);expect(result.amount).toBe('100');
 expect(result.classification).toBe('candidate');expect(result.missing).toContain('independent_statement_review_unavailable');
});
it('never derives missing transactions from empty days or completeness from a matching OCR population',()=>{
 expect(analyseBankStatementCompleteness({...row(),importedCount:10,importedNet:'500'}).reasons).toEqual([]);
 expect(analyseBankStatementCompleteness({...row(),sourceCount:0,opening:'1000',closing:'1000',importedCount:0,importedNet:'0'}).missing)
 .toContain('independent_statement_review_unavailable');
 expect(analyseBankStatementCompleteness({...row(),sourceBytesVerified:false}).missing).toContain('source_statement_bytes_unavailable_or_changed');
});
it('allows a completed local independent review to clear comparison unknowns while changed bytes still refuse',()=>{
 const reviewed={...row(),independentlyReviewed:true,sourceCount:0,opening:'-10',closing:'-10',importedCount:0,importedNet:'0'};
 expect(analyseBankStatementCompleteness(reviewed)).toMatchObject({missing:[],reasons:[],amount:'0'});
 expect(analyseBankStatementCompleteness({...reviewed,sourceBytesVerified:false}).missing).toContain('source_statement_bytes_unavailable_or_changed');
 expect(analyseBankStatementCompleteness({...reviewed,importedCount:1,importedNet:'1'}).reasons).toEqual(['statement_count_difference','statement_balance_difference']);
});
