import {expect,it} from 'vitest';
import {loadBankTransferState} from '@/modules/accounting/services/bank/bankAllocationTransferState';
it('requires an issued state context before accessing plan or SQL',async()=>{await expect(loadBankTransferState({} as never,{} as never,false)).rejects.toThrow(/control|authenticated/i);});
