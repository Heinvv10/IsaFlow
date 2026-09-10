import {expect,it} from 'vitest';
import {detachGlInput,meaningfulGlRow} from '@/modules/accounting/services/gl/glAccountChangeRows';
it('detaches optional legacy fields without invoking accessors or accepting lossy nested values',()=>{
 const value={name:'original',description:undefined,nested:{level:2}};const copy=detachGlInput(value);value.nested.level=9;
 expect(copy).toEqual({name:'original',nested:{level:2}});let calls=0;
 expect(()=>detachGlInput({get name(){calls++;return 'unsafe';}})).toThrow();expect(calls).toBe(0);
 expect(()=>detachGlInput({nested:{absent:undefined}})).toThrow();expect(()=>detachGlInput(Object.create({name:'inherited'}) as object)).toThrow();
});
it('ignores only update bookkeeping in substantive no-op comparisons',()=>{
 const row={id:'id',account_code:'1000',bank_opening_balance:'1000000000000.10',updated_at:'one',created_at:'original'};
 expect(meaningfulGlRow(row)).toBe(meaningfulGlRow({...row,updated_at:'two'}));
 expect(meaningfulGlRow(row)).not.toBe(meaningfulGlRow({...row,bank_opening_balance:'1000000000000.11'}));
 expect(meaningfulGlRow(row)).not.toBe(meaningfulGlRow({...row,created_at:'changed'}));
 expect(meaningfulGlRow(null)).not.toBe(meaningfulGlRow(row));
});
