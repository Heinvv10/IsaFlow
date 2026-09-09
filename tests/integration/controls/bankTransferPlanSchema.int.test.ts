import {afterAll,beforeAll,expect,it} from 'vitest';
import {transferFixture} from './bankTransferSourcesFixture';
let f:Awaited<ReturnType<typeof transferFixture>>;
beforeAll(async()=>{f=await transferFixture();});afterAll(async()=>{if(f)await f.close();});
it('persists a bank-bound original transfer plan in actual immutable storage',async()=>{
 const bank=await f.bank();await expect(f.intent(bank)).resolves.toMatch(/^[a-f0-9-]{36}$/);
});
it.each(['missing mode','mixed mode','self opposite','bad UUID','bank association','missing opposite'])('rejects %s in actual immutable transfer storage',async failure=>{
 const bank=await f.bank(),payload:Record<string,unknown>={version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.to,transfer:{mode:'post',oppositeBankTransactionId:null}};
 if(failure==='missing mode')payload.transfer={oppositeBankTransactionId:null};
 if(failure==='mixed mode')payload.transfer={mode:'post',oppositeBankTransactionId:null,originalIntentId:bank};
 if(failure==='self opposite')payload.transfer={mode:'post',oppositeBankTransactionId:bank};
 if(failure==='bad UUID')payload.counterpartyAccountId='invalid';
 if(failure==='bank association')payload.bankTransactionId=f.from;
 if(failure==='missing opposite')payload.transfer={mode:'post'};
 await expect(f.intent(bank,f.to,payload)).rejects.toMatchObject({code:'23514',constraint:'control_bank_allocation_intents_payload_check'});
});
it('preserves existing nontransfer payload constraint compatibility and accepts link mode',async()=>{
 const bank=await f.bank();
 for(const kind of ['account','split','customer','supplier'])await expect(f.intent(bank,f.to,{version:1,kind})).resolves.toMatch(/^[a-f0-9-]{36}$/);
 await expect(f.intent(bank,f.to,{version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.to,transfer:{mode:'link',originalIntentId:bank}})).resolves.toMatch(/^[a-f0-9-]{36}$/);
});
