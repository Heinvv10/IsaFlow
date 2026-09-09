import {expect,it} from 'vitest';
import {deriveArRecurringMoney} from '@/modules/accounting/services/controls/arRecurringExact';
it('derives decimal line rounding and tax without floating arithmetic',()=>{
 const result=deriveArRecurringMoney({currency_code:'ZAR',tax_rate:'15',line_items:[{description:'Service',quantity:'3',unitPrice:'0.335'}]},'ZAR');
 expect(result).toMatchObject({subtotal:'1.01',tax:'0.15',amount:'1.16',currency:'ZAR'});
 expect(result.lines[0]).toMatchObject({quantity:'3',unit_price:'0.335',amount:'1.01'});
});
it('refuses invalid populations, currencies and materially inconsistent stored totals',()=>{
 for(const row of [{line_items:[]},{line_items:[{description:'X',quantity:0,unitPrice:10}]},{currency_code:'USD'},{subtotal:'99'}]){
  expect(()=>deriveArRecurringMoney({currency_code:'ZAR',tax_rate:'15',line_items:[{description:'X',quantity:1,unitPrice:10}],...row},'ZAR')).toThrow();
 }
});
it('retains the documented one-cent-per-line legacy aggregate tolerance',()=>{
 expect(deriveArRecurringMoney({currency_code:'ZAR',tax_rate:'0',subtotal:'1.00',line_items:[{description:'X',quantity:3,unitPrice:0.335}]},'ZAR').amount).toBe('1.01');
});
