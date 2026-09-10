import {expect,it,vi} from 'vitest';
import {parseDefaultAccountsInput} from '@/modules/accounting/services/gl/defaultAccountsInput';
const id='11111111-1111-4111-8111-111111111111';
it('preserves whole-map omission and explicit empty/null clearing',()=>{
 expect(parseDefaultAccountsInput({mappings:{primary_bank:'',accounts_receivable:null}})).toEqual({primary_bank:'',accounts_receivable:null});
 expect(parseDefaultAccountsInput({mappings:{}})).toEqual({});
});
it('rejects duplicate account roles and unknown/invalid inputs',()=>{
 for(const value of [{mappings:{primary_bank:id,accounts_receivable:id}},{mappings:{unknown:id}},{mappings:{primary_bank:'invalid'}},{mappings:[]},{mappings:{},companyId:id}])expect(()=>parseDefaultAccountsInput(value)).toThrow();
});
it('does not invoke accessors and detaches caller objects',()=>{
 const getter=vi.fn(()=>id);expect(()=>parseDefaultAccountsInput({mappings:{get primary_bank(){return getter();}}})).toThrow();expect(getter).not.toHaveBeenCalled();
 const input={mappings:{primary_bank:id}},result=parseDefaultAccountsInput(input);input.mappings.primary_bank='changed';expect(result.primary_bank).toBe(id);
});
