import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {lockBankTransferPair,readBankTransferCandidates} from '@/modules/accounting/services/bank/bankAllocationTransferSources';
it('refuses unissued contexts before transfer lookup or locks',async()=>{
 await expect(lockBankTransferPair({} as never,'source','counterparty')).rejects.toThrow(/control|authenticated/i);
 await expect(readBankTransferCandidates({} as never,{bankTransactionId:'source',counterpartyAccountId:'counterparty'})).rejects.toThrow(/control|authenticated/i);
});
it('detaches strict input without invoking accessors or issuing SQL',async()=>{
 const query=vi.fn(),getter=vi.fn(()=> '11111111-1111-4111-8111-111111111111'),client={query} as unknown as PoolClient;
 await withControlRequest({client,userId:'user',companyId:'company',claims:{}},{personId:'user',companyId:'company',authMethod:'cookie'},async()=>{
  const input={counterpartyAccountId:'22222222-2222-4222-8222-222222222222'};
  Object.defineProperty(input,'bankTransactionId',{enumerable:true,get:getter});
  await expect(readBankTransferCandidates(requireControlTx(),input)).rejects.toThrow();
  await expect(readBankTransferCandidates(requireControlTx(),{bankTransactionId:'invalid',counterpartyAccountId:'invalid',companyId:'other'})).rejects.toThrow();
 });
 expect(getter).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
});
