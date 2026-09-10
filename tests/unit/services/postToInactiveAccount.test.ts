/** Actual shared-writer inactive throws/tenant isolation are gl39Posting PG (GL27-32). */
import {expect,it} from 'vitest';
import {InactiveAccountError} from '@/modules/accounting/services/gl/journalEntryPostingService';
it('exported inactive error retains every account code and actionable remedy',()=>{
 const error=new InactiveAccountError([{code:'1121',name:'Cash'},{code:'2120',name:'VAT'}]);
 expect(error).toBeInstanceOf(Error);expect(error.name).toBe('InactiveAccountError');expect(error.accounts).toEqual(['1121','2120']);expect(error.message).toMatch(/1121.*2120/);expect(error.message).toMatch(/reactivate.*recode/i);
});
