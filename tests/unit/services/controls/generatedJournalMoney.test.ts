import {expect,it} from 'vitest';
import {assertGeneratedJournalMoney} from '@/modules/accounting/services/controls/generatedJournalMoney';
it('accepts exact equivalent monetary representations',()=>{
 expect(()=>assertGeneratedJournalMoney({amount:'100.00',currency:'ZAR'},{amount:'100',currency:'ZAR'})).not.toThrow();
});
it.each([
 [{amount:'100',currency:'USD'},{amount:'100',currency:'ZAR'}],
 [{amount:'100',currency:'ZAR'},{amount:'101',currency:'ZAR'}],
 [{amount:null,currency:null},{amount:'100',currency:'ZAR'}],
 [{amount:'9007199254740993.01',currency:'ZAR'},{amount:'9007199254740993.02',currency:'ZAR'}],
])('refuses monetary effects outside the exact parent binding', (parent,child)=>{
 expect(()=>assertGeneratedJournalMoney(parent,child)).toThrow();
});
