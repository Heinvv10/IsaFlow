import {expect,it} from 'vitest';
import {lockBankTransferPair,readBankTransferCandidates} from '@/modules/accounting/services/bank/bankAllocationTransferSources';
it('refuses unissued contexts before transfer lookup or locks',async()=>{
 await expect(lockBankTransferPair({} as never,'source','counterparty')).rejects.toThrow(/control|authenticated/i);
 await expect(readBankTransferCandidates({} as never,{bankTransactionId:'source',counterpartyAccountId:'counterparty'})).rejects.toThrow(/control|authenticated/i);
});
