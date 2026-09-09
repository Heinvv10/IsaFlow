import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {als} from '@/lib/als';
import {autoLinkCounterpartyTransfer} from '@/modules/accounting/services/bank/bankTransferAutoLink';
const input={companyId:'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',bankTxId:'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb',
 bankAccountId:'cccccccc-0000-0000-0000-cccccccccccc',counterpartyAccountId:'dddddddd-0000-0000-0000-dddddddddddd',
 journalEntryId:'eeeeeeee-0000-0000-0000-eeeeeeeeeeee',amount:-500,txDate:'2026-08-01',allocatedEntityName:'Synthetic bank'};
it('refuses legacy transfer linking outside an authenticated control transaction',async()=>{
 await expect(autoLinkCounterpartyTransfer(input)).rejects.toThrow('Authenticated control transaction required');
});
it('an arbitrary ALS client cannot authorize any legacy transfer SQL',async()=>{
 const client={query:vi.fn()};
 await expect(als.run({client:client as unknown as PoolClient,userId:'untrusted',companyId:input.companyId,claims:{}},
  ()=>autoLinkCounterpartyTransfer(input))).rejects.toThrow('Authenticated control transaction required');
 expect(client.query).not.toHaveBeenCalled();
});
// Real approved producer and caught SQL rollback evidence lives in controls/bankTransfer* integration suites.
